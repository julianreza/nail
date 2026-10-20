import { describe, expect, it } from "vitest";
import { SubscriptionProviderError } from "../../../lib/server/providers/subscription-errors";
import { parseAntigravityCompletion } from "../../../worker/providers/antigravity-protocol";

const success = [
  { event: "init", conversation_id: "test-conversation", init: { cwd: "/empty", tools: [] } },
  { event: "step_update", step_update: { step_type: "agent_response", text_delta: "partial " } },
  { event: "result", result: {
    conversation_id: "test-conversation",
    status: "SUCCESS",
    response: "NAIL_OK",
    num_turns: 1,
    usage: { input_tokens: 12, output_tokens: 3 },
  } },
].map((event) => JSON.stringify(event)).join("\n");

describe("Antigravity subscription protocol parser", () => {
  it("returns only the terminal response and final-turn usage", () => {
    expect(parseAntigravityCompletion(success, 0, "gemini-4-argon-medium")).toEqual({
      text: "NAIL_OK",
      model: "gemini-4-argon-medium",
      usage: { inputTokens: 12, outputTokens: 3 },
      finishReason: "stop",
    });
  });

  it("treats missing usage as unknown and rejects non-success terminal states", () => {
    const noUsage = [
      JSON.stringify({ event: "init", conversation_id: "test", init: { tools: [] } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok", num_turns: 1 } }),
    ].join("\n");
    expect(parseAntigravityCompletion(noUsage, 0, "model").usage)
      .toEqual({ inputTokens: null, outputTokens: null });
    for (const status of ["ERROR", "WAITING", "RUNNING", "CANCELED", "INTERRUPTED", "INVALID"]) {
      const frame = [
        JSON.stringify({ event: "init", conversation_id: "test", init: { tools: [] } }),
        JSON.stringify({ event: "result", result: { status, response: "partial", num_turns: 1 } }),
      ].join("\n");
      expect(() => parseAntigravityCompletion(frame, 0, "model")).toThrow(SubscriptionProviderError);
    }
  });

  it("rejects tool, subagent, failed-exit and incomplete runs", () => {
    const tool = [
      { event: "init", conversation_id: "test", init: { tools: ["run_command"] } },
      { event: "step_update", step_update: { step_type: "tool", tool_name: "run_command" } },
      { event: "result", result: { status: "SUCCESS", response: "bad", num_turns: 1 } },
    ].map((event) => JSON.stringify(event)).join("\n");
    const subagent = JSON.stringify({
      event: "step_update", step_update: { step_type: "agent_response", subagent_info: { subagents: [] } },
    });
    const incomplete = JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response" } });
    expect(() => parseAntigravityCompletion(tool, 0, "model")).toThrow(SubscriptionProviderError);
    expect(() => parseAntigravityCompletion(subagent, 0, "model")).toThrow(SubscriptionProviderError);
    expect(() => parseAntigravityCompletion(success, 1, "model")).toThrow(SubscriptionProviderError);
    expect(() => parseAntigravityCompletion(incomplete, 0, "model")).toThrow(SubscriptionProviderError);
  });

  it("rejects malformed, oversized and duplicate terminal events", () => {
    expect(() => parseAntigravityCompletion("{bad}", 0, "model")).toThrowError(
      new SubscriptionProviderError("invalid_output"),
    );
    expect(() => parseAntigravityCompletion("x".repeat(1024 * 1024 + 1), 0, "model"))
      .toThrowError(new SubscriptionProviderError("output_limit"));
    const result = JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } });
    expect(() => parseAntigravityCompletion(`${success}\n${result}`, 0, "model"))
      .toThrowError(new SubscriptionProviderError("invalid_output"));
  });
});
