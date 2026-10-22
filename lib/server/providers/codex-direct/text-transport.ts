import { parseCodexSseStream } from "./text-protocol";
import { CodexDirectError, type CodexTokens } from "./types";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const MAX_PROMPT_BYTES = 4096;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOTAL_MS = 30_000;
const MAX_IDLE_MS = 10_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalidRequest(): never { throw new CodexDirectError("invalid_request"); }

export async function probeCodexText(
  input: { tokens: CodexTokens; model: string; prompt: string; signal: AbortSignal },
  dependencies: { fetcher: typeof fetch },
): Promise<{ text: string; usage: { inputTokens: number | null; outputTokens: number | null } }> {
  if (
    typeof input.prompt !== "string" || Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES ||
    typeof input.model !== "string" || !MODEL_ID.test(input.model) ||
    typeof input.tokens?.accessToken !== "string" || Buffer.byteLength(input.tokens.accessToken) > 16 * 1024 ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(input.tokens.accountId)
  ) invalidRequest();
  if (input.signal.aborted) throw new CodexDirectError("cancelled");

  const controller = new AbortController();
  let abortCode: "cancelled" | "timeout" | null = null;
  let rejectAbort!: (error: CodexDirectError) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  controller.signal.addEventListener("abort", () => {
    rejectAbort(new CodexDirectError(abortCode ?? "cancelled"));
  }, { once: true });
  const abortCaller = () => {
    abortCode = "cancelled";
    controller.abort();
  };
  input.signal.addEventListener("abort", abortCaller, { once: true });
  const totalTimer = setTimeout(() => {
    abortCode = "timeout";
    controller.abort();
  }, MAX_TOTAL_MS);

  let response: Response | undefined;
  try {
    const body = {
      model: input.model,
      instructions: "Return a short plain-text answer. Do not call tools.",
      input: [{ role: "user", content: [{ type: "input_text", text: input.prompt }] }],
      tools: [],
      tool_choice: "none",
      store: false,
      stream: true,
    };
    try {
      response = await Promise.race([
        dependencies.fetcher(ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.tokens.accessToken}`,
            "chatgpt-account-id": input.tokens.accountId,
            originator: "nail",
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        }),
        abortPromise,
      ]);
    } catch (error) {
      if (error instanceof CodexDirectError) throw error;
      throw new CodexDirectError("unavailable");
    }
    if (response.status >= 300 && response.status < 400) throw new CodexDirectError("unsupported_protocol");
    if (response.status === 401 || response.status === 403) throw new CodexDirectError("needs_login");
    if (response.status === 429) throw new CodexDirectError("rate_limited");
    if (response.status >= 500) throw new CodexDirectError("unavailable");
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw new CodexDirectError("unsupported_protocol");
    }
    if (!response.body) throw new CodexDirectError("unsupported_protocol");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const cancelReader = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener("abort", cancelReader, { once: true });
    try {
      while (true) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const idleTimeout = new Promise<never>((_resolve, reject) => {
          idleTimer = setTimeout(() => {
            abortCode = "timeout";
            controller.abort();
            reject(new CodexDirectError("timeout"));
          }, MAX_IDLE_MS);
        });
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await Promise.race([reader.read(), idleTimeout, abortPromise]);
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
        if (controller.signal.aborted) throw new CodexDirectError(abortCode ?? "cancelled");
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) throw new CodexDirectError("output_limit");
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof CodexDirectError) throw error;
      throw new CodexDirectError("unavailable");
    } finally {
      controller.signal.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }

    const replay = new ReadableStream<Uint8Array>({
      start(streamController) {
        for (const chunk of chunks) streamController.enqueue(chunk);
        streamController.close();
      },
    });
    return await parseCodexSseStream(replay, input.signal);
  } catch (error) {
    if (error instanceof CodexDirectError) throw error;
    if (input.signal.aborted) throw new CodexDirectError("cancelled");
    throw new CodexDirectError("unavailable");
  } finally {
    clearTimeout(totalTimer);
    input.signal.removeEventListener("abort", abortCaller);
  }
}
