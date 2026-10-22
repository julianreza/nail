import type { SubscriptionCompletion } from "../../lib/domain/subscription-provider";
import { SubscriptionProviderError } from "../../lib/server/providers/subscription-errors";
import type { ProviderProcessResult } from "./process-runner";

export interface CodexLoginDiagnostic {
  state: "connected" | "needs_login" | "unsupported";
  reason: "needs_login" | "wrong_auth_mode" | "auth_status_unverified" | null;
}

export function parseCodexLoginStatus(
  result: Pick<ProviderProcessResult, "stdout" | "stderr" | "exitCode">,
): CodexLoginDiagnostic {
  const unknown: CodexLoginDiagnostic = { state: "unsupported", reason: "auth_status_unverified" };
  if (result.stdout !== "") return unknown;
  if (result.exitCode === 0 && /^Logged in using ChatGPT(?:\r?\n)?$/.test(result.stderr)) {
    return { state: "connected", reason: null };
  }
  if (result.exitCode === 1 && /^Not logged in(?:\r?\n)?$/.test(result.stderr)) {
    return { state: "needs_login", reason: "needs_login" };
  }
  if (result.exitCode === 0 && /^API key configured - [^\r\n]+(?:\r?\n|$)/.test(result.stderr)) {
    return { state: "unsupported", reason: "wrong_auth_mode" };
  }
  return unknown;
}

const MAX_JSONL_BYTES = 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROGRESS_EVENTS = new Set(["thread.started", "turn.started", "turn.resumed"]);
const SAFE_ITEM_EVENTS = new Set(["item.started", "item.updated", "item.completed"]);

function invalidOutput(): never {
  throw new SubscriptionProviderError("invalid_output");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsage(value: unknown): { inputTokens: number | null; outputTokens: number | null } {
  if (value === undefined) return { inputTokens: null, outputTokens: null };
  if (!isRecord(value)) return invalidOutput();
  const input = value.input_tokens;
  const output = value.output_tokens;
  if (
    (input !== undefined && (!Number.isSafeInteger(input) || (input as number) < 0)) ||
    (output !== undefined && (!Number.isSafeInteger(output) || (output as number) < 0))
  ) return invalidOutput();
  return {
    inputTokens: typeof input === "number" ? input : null,
    outputTokens: typeof output === "number" ? output : null,
  };
}

export function parseCodexCompletion(
  jsonl: string,
  exitCode: number,
  selectedModel: string,
): SubscriptionCompletion {
  if (typeof jsonl !== "string" || Buffer.byteLength(jsonl, "utf8") > MAX_JSONL_BYTES) {
    throw new SubscriptionProviderError("output_limit");
  }
  if (exitCode !== 0 || !MODEL_ID.test(selectedModel)) return invalidOutput();

  let text: string | null = null;
  let usage: SubscriptionCompletion["usage"] = { inputTokens: null, outputTokens: null };
  let terminalSeen = false;

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return invalidOutput();
    }
    if (!isRecord(event) || typeof event.type !== "string" || terminalSeen) return invalidOutput();

    if (SAFE_PROGRESS_EVENTS.has(event.type)) continue;
    if (SAFE_ITEM_EVENTS.has(event.type)) {
      if (!isRecord(event.item) || event.item.type !== "agent_message") return invalidOutput();
      if (event.type === "item.completed") {
        if (text !== null || typeof event.item.text !== "string" || event.item.text.length === 0) return invalidOutput();
        text = event.item.text;
      }
      continue;
    }
    if (event.type === "turn.failed" || event.type === "error") return invalidOutput();
    if (event.type === "turn.completed") {
      terminalSeen = true;
      usage = parseUsage(event.usage);
      continue;
    }
    return invalidOutput();
  }

  if (!terminalSeen || text === null) return invalidOutput();
  return { text, model: selectedModel, usage, finishReason: "stop" };
}
