import { describe, expect, it } from "vitest";
import { parseCodexSseStream } from "../../../../lib/server/providers/codex-direct/text-protocol";

const encoder = new TextEncoder();
function stream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
function event(value: unknown) { return `data: ${JSON.stringify(value)}\n\n`; }
function completed(text: string, usage: unknown = { input_tokens: 7, output_tokens: 3 }) {
  return { type: "response.completed", response: {
    status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage,
  } };
}

describe("Codex direct SSE text-only parser", () => {
  it("streams split UTF-8 and reconciles deltas with the terminal text", async () => {
    const source = [
      ": heartbeat\r\n\r\n",
      "data: {\"type\":\"response.created\",\n",
      "data: \"response\":{}}\r\n\r\n",
      event({ type: "response.in_progress", response: {} }),
      event({ type: "response.output_item.added", item: { type: "message" } }),
      event({ type: "response.content_part.added", part: { type: "output_text", text: "" } }),
      event({ type: "response.output_text.delta", delta: "hé" }),
      event({ type: "response.output_text.done", text: "hé" }),
      event({ type: "response.content_part.done", part: { type: "output_text", text: "hé" } }),
      event({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "hé" }] } }),
      event(completed("hé")),
      "data: [DONE]",
    ].join("");
    const bytes = encoder.encode(source);
    const marker = Buffer.from("é", "utf8");
    const index = Buffer.from(bytes).indexOf(marker);
    const result = await parseCodexSseStream(byteStream([bytes.slice(0, index + 1), bytes.slice(index + 1)]));
    expect(result).toEqual({ text: "hé", usage: { inputTokens: 7, outputTokens: 3 } });
  });

  it("accepts a final frame at EOF and leaves missing usage unknown", async () => {
    const result = await parseCodexSseStream(stream([event(completed("plain text", {})).trimEnd()]));
    expect(result).toEqual({ text: "plain text", usage: { inputTokens: null, outputTokens: null } });
  });

  it.each([
    ["missing terminal completion", event({ type: "response.output_text.delta", delta: "partial" })],
    ["mismatched completed text", event({ type: "response.output_text.delta", delta: "partial" }) + event(completed("different"))],
    ["malformed JSON", "data: {not-json}\n\n"],
    ["truncated text-only event", event({ type: "response.output_text.delta", delta: "partial" }) + event({ type: "response.completed", response: { status: "completed", output: [], usage: {} } })],
    ["failed response", event({ type: "response.failed", response: {} })],
    ["incomplete response", event({ type: "response.incomplete", response: {} })],
    ["unknown event", event({ type: "response.tool_call", tool: {} })],
    ["tool output item", event({ type: "response.output_item.added", item: { type: "function_call", name: "shell" } })],
    ["unsafe usage", event(completed("text", { input_tokens: -1, output_tokens: 2 }))],
  ])("fails closed for %s", async (_label, source) => {
    await expect(parseCodexSseStream(stream([source]))).rejects.toMatchObject({ code: "unsupported_protocol" });
  });

  it("rejects output limits without exposing raw event text", async () => {
    const secret = "sse-secret-fixture";
    await expect(parseCodexSseStream(stream([event({ type: "error", error: secret })]))).rejects.toMatchObject({ code: "unsupported_protocol" });
  });
});
