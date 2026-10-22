import { CodexDirectError } from "./types";

export interface CodexTextResult {
  text: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

const MAX_TEXT_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

function invalid(): never {
  throw new CodexDirectError("unsupported_protocol");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_TEXT_BYTES) return invalid();
  return value;
}

function textItem(value: unknown): string {
  if (!record(value) || value.type !== "message" || !Array.isArray(value.content)) return invalid();
  const chunks: string[] = [];
  for (const part of value.content) {
    if (!record(part) || part.type !== "output_text") return invalid();
    chunks.push(requireText(part.text));
  }
  if (chunks.length === 0) return invalid();
  return chunks.join("");
}

function usageCounts(value: unknown): CodexTextResult["usage"] {
  if (value === undefined || value === null) return { inputTokens: null, outputTokens: null };
  if (!record(value)) return invalid();
  const input = value.input_tokens;
  const output = value.output_tokens;
  if ((input !== undefined && (!Number.isSafeInteger(input) || (input as number) < 0)) ||
    (output !== undefined && (!Number.isSafeInteger(output) || (output as number) < 0))) return invalid();
  return {
    inputTokens: typeof input === "number" ? input : null,
    outputTokens: typeof output === "number" ? output : null,
  };
}

export async function parseCodexSseStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<CodexTextResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let dataLines: string[] = [];
  let totalBytes = 0;
  let deltaText = "";
  let deltaSeen = false;
  let terminalText: string | null = null;
  let terminalUsage: CodexTextResult["usage"] | null = null;
  let completed = false;
  let doneMarker = false;

  const setTerminalText = (text: string) => {
    if (terminalText !== null && terminalText !== text) return invalid();
    if (deltaSeen && deltaText !== text) return invalid();
    terminalText = text;
  };

  const dispatch = (payload: string) => {
    if (payload === "[DONE]") {
      if (!completed) return invalid();
      doneMarker = true;
      return;
    }
    if (doneMarker || completed) return invalid();
    let event: unknown;
    try { event = JSON.parse(payload) as unknown; } catch { return invalid(); }
    if (!record(event) || typeof event.type !== "string") return invalid();
    switch (event.type) {
      case "response.created":
      case "response.in_progress":
        if (event.response !== undefined && !record(event.response)) return invalid();
        return;
      case "response.output_item.added":
        if (!record(event.item) || event.item.type !== "message") return invalid();
        return;
      case "response.content_part.added":
        if (!record(event.part) || event.part.type !== "output_text") return invalid();
        if (event.part.text !== undefined) requireText(event.part.text);
        return;
      case "response.output_text.delta":
        deltaText += requireText(event.delta);
        deltaSeen = true;
        if (Buffer.byteLength(deltaText) > MAX_TEXT_BYTES) throw new CodexDirectError("output_limit");
        return;
      case "response.output_text.done":
        setTerminalText(requireText(event.text));
        return;
      case "response.content_part.done":
        if (!record(event.part) || event.part.type !== "output_text") return invalid();
        setTerminalText(requireText(event.part.text));
        return;
      case "response.output_item.done":
        setTerminalText(textItem(event.item));
        return;
      case "response.completed": {
        if (!record(event.response) || event.response.status !== "completed" || !Array.isArray(event.response.output)) return invalid();
        const finalText = event.response.output.map(textItem).join("");
        if (!finalText || Buffer.byteLength(finalText) > MAX_TEXT_BYTES) return invalid();
        setTerminalText(finalText);
        terminalUsage = usageCounts(event.response.usage);
        completed = true;
        return;
      }
      case "response.failed":
      case "response.incomplete":
      case "error":
        return invalid();
      default:
        return invalid();
    }
  };

  const processLine = (line: string) => {
    if (line === "") {
      if (dataLines.length > 0) dispatch(dataLines.join("\n"));
      dataLines = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== "data") return;
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  };

  const processBuffer = (flush: boolean) => {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      processLine(line);
    }
    if (flush && buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      processLine(line);
      buffer = "";
    }
  };

  const abortReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new CodexDirectError("cancelled");
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_FRAME_BYTES) throw new CodexDirectError("output_limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      processBuffer(false);
    }
    buffer += decoder.decode();
    processBuffer(true);
    if (dataLines.length > 0) dispatch(dataLines.join("\n"));
    if (!completed || terminalText === null || !terminalUsage) return invalid();
    return { text: terminalText, usage: terminalUsage };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CodexDirectError) throw error;
    return invalid();
  } finally {
    signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
}
