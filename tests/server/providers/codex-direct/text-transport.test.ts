import { describe, expect, it, vi } from "vitest";
import { probeCodexText } from "../../../../lib/server/providers/codex-direct/text-transport";
import { CodexDirectError } from "../../../../lib/server/providers/codex-direct/types";
import { tokensFixture } from "./fixtures";

const tokens = {
  accessToken: tokensFixture().access_token,
  refreshToken: "refresh_fixture",
  expiresAt: Date.now() + 3_600_000,
  accountId: "fixture_account",
};
function event(value: unknown) { return `data: ${JSON.stringify(value)}\n\n`; }
function completed(text: string) {
  return { type: "response.completed", response: {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 12, output_tokens: 4 },
  } };
}
function responseStream(text: string) {
  const encoder = new TextEncoder();
  const body = [event({ type: "response.created", response: {} }), event({ type: "response.output_text.delta", delta: text }), event(completed(text))].join("");
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(body)); controller.close(); } }), {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

describe("quarantined Codex direct text probe", () => {
  it("sends one fixed-origin text-only request without output limit or tool execution", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(responseStream("NAIL_OK"));
    const result = await probeCodexText({ tokens, model: "fixture-model", prompt: "Reply with exactly NAIL_OK", signal: new AbortController().signal }, { fetcher });
    expect(result).toEqual({ text: "NAIL_OK", usage: { inputTokens: 12, outputTokens: 4 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${tokens.accessToken}`);
    expect(headers.get("chatgpt-account-id")).toBe("fixture_account");
    expect(headers.get("originator")).toBe("nail");
    expect(headers.get("accept")).toBe("text/event-stream");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: "fixture-model",
      instructions: "Return a short plain-text answer. Do not call tools.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly NAIL_OK" }] }],
      tools: [], tool_choice: "none", store: false, stream: true,
    });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("previous_response_id");
  });

  it("rejects oversized prompts before contacting the backend", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(probeCodexText({ tokens, model: "fixture-model", prompt: "x".repeat(4097), signal: new AbortController().signal }, { fetcher }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects raw vendor errors and never retries HTTP failures", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("refresh_secret_fixture", { status: 429 }));
    await expect(probeCodexText({ tokens, model: "fixture-model", prompt: "probe", signal: new AbortController().signal }, { fetcher }))
      .rejects.toMatchObject({ code: "rate_limited" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects tool events and missing terminal output without returning partial text", async () => {
    const encoder = new TextEncoder();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(event({ type: "response.output_item.added", item: { type: "function_call", name: "shell" } }))); controller.close(); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    await expect(probeCodexText({ tokens, model: "fixture-model", prompt: "probe", signal: new AbortController().signal }, { fetcher }))
      .rejects.toMatchObject({ code: "unsupported_protocol" });
  });

  it("rejects a live response larger than the transport byte cap", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));
    await expect(probeCodexText({ tokens, model: "fixture-model", prompt: "probe", signal: new AbortController().signal }, { fetcher }))
      .rejects.toMatchObject({ code: "output_limit" });
  });

  it("maps cancelled requests to a fixed safe code", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(probeCodexText({ tokens, model: "fixture-model", prompt: "probe", signal: controller.signal }, { fetcher }))
      .rejects.toBeInstanceOf(CodexDirectError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
