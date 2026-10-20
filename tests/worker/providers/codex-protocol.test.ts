import { describe, expect, it } from "vitest";
import { SubscriptionProviderError } from "../../../lib/server/providers/subscription-errors";
import { parseCodexCompletion } from "../../../worker/providers/codex-protocol";

const success = [
  { type: "thread.started", thread_id: "test-thread" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "answer", type: "agent_message", text: "NAIL_OK" } },
  { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3 } },
].map((event) => JSON.stringify(event)).join("\n");

describe("Codex subscription protocol parser", () => {
  it("returns only the completed agent message and token usage", () => {
    expect(parseCodexCompletion(success, 0, "gpt-codex-model")).toEqual({
      text: "NAIL_OK",
      model: "gpt-codex-model",
      usage: { inputTokens: 12, outputTokens: 3 },
      finishReason: "stop",
    });
  });

  it("treats absent usage as unknown rather than zero", () => {
    const jsonl = [
      { type: "item.completed", item: { id: "answer", type: "agent_message", text: "ok" } },
      { type: "turn.completed" },
    ].map((event) => JSON.stringify(event)).join("\n");
    expect(parseCodexCompletion(jsonl, 0, "selected-model").usage)
      .toEqual({ inputTokens: null, outputTokens: null });
  });

  it("rejects tool events, failed turns, nonzero exit and incomplete output", () => {
    const toolEvent = [
      { type: "item.started", item: { id: "command", type: "command_execution", command: "cat /etc/passwd" } },
      { type: "item.completed", item: { id: "answer", type: "agent_message", text: "no" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ].map((event) => JSON.stringify(event)).join("\n");
    const failedTurn = JSON.stringify({ type: "turn.failed", error: { message: "raw secret" } });
    const incomplete = JSON.stringify({
      type: "item.completed", item: { id: "answer", type: "agent_message", text: "partial" },
    });
    expect(() => parseCodexCompletion(toolEvent, 0, "model")).toThrow(SubscriptionProviderError);
    expect(() => parseCodexCompletion(failedTurn, 0, "model")).toThrow(SubscriptionProviderError);
    expect(() => parseCodexCompletion(success, 1, "model")).toThrow(SubscriptionProviderError);
    expect(() => parseCodexCompletion(incomplete, 0, "model")).toThrow(SubscriptionProviderError);
  });

  it("rejects malformed, oversized and duplicate terminal frames", () => {
    expect(() => parseCodexCompletion("{bad json}", 0, "model")).toThrowError(
      new SubscriptionProviderError("invalid_output"),
    );
    expect(() => parseCodexCompletion(" ".repeat(1024 * 1024 + 1), 0, "model"))
      .toThrowError(new SubscriptionProviderError("output_limit"));
    expect(() => parseCodexCompletion(`${success}\n${JSON.stringify({ type: "turn.completed" })}`, 0, "model"))
      .toThrowError(new SubscriptionProviderError("invalid_output"));
  });
});
