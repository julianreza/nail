const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MESSAGE = "Permintaan Codex melewati batas waktu. Muat ulang status sebelum mencoba lagi.";

function responseError(value: unknown): string | null {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
    ? value.error
    : null;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Respons Codex tidak valid.");
  const abortReader = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abortReader, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("Permintaan Codex dibatalkan.");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("Permintaan Codex dibatalkan.");
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Respons Codex terlalu besar.");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("Respons Codex tidak valid.");
    }
    if (!response.ok) throw new Error(responseError(body) ?? "Permintaan Codex tidak dapat diproses.");
    return body;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
}

/** Bound the complete browser request, including response-body reads. Never retry mutations. */
export async function requestCodexJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectAborted!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted(new Error(timedOut ? TIMEOUT_MESSAGE : "Permintaan Codex dibatalkan."));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const cancel = () => controller.abort();
  const parentSignal = init.signal;
  parentSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    if (parentSignal?.aborted) controller.abort();
    if (controller.signal.aborted) return await aborted;
    const operation = (async () => {
      const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Permintaan Codex dibatalkan.");
      }
      return readJson(response, controller.signal);
    })();
    return await Promise.race([operation, aborted]);
  } catch (error) {
    if (timedOut) throw new Error(TIMEOUT_MESSAGE);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
