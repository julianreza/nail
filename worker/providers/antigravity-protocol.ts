import type { SubscriptionCompletion } from "../../lib/domain/subscription-provider";
import { SubscriptionProviderError } from "../../lib/server/providers/subscription-errors";

const MAX_JSONL_BYTES = 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_STEP_TYPES = new Set(["user_input", "agent_response", "checkpoint"]);

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

export function parseAntigravityCompletion(
  jsonl: string,
  exitCode: number,
  selectedModel: string,
): SubscriptionCompletion {
  if (typeof jsonl !== "string" || Buffer.byteLength(jsonl, "utf8") > MAX_JSONL_BYTES) {
    throw new SubscriptionProviderError("output_limit");
  }
  if (exitCode !== 0 || !MODEL_ID.test(selectedModel)) return invalidOutput();

  let initialized = false;
  let terminalSeen = false;
  let text: string | null = null;
  let usage: SubscriptionCompletion["usage"] = { inputTokens: null, outputTokens: null };

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return invalidOutput();
    }
    if (!isRecord(event) || typeof event.event !== "string" || terminalSeen) return invalidOutput();

    if (event.event === "init") {
      if (initialized || !isRecord(event.init) || typeof event.conversation_id !== "string") return invalidOutput();
      initialized = true;
      continue;
    }
    if (!initialized) return invalidOutput();

    if (event.event === "step_update") {
      if (!isRecord(event.step_update) || !SAFE_STEP_TYPES.has(String(event.step_update.step_type))) {
        return invalidOutput();
      }
      if ("tool_info" in event.step_update || "subagent_info" in event.step_update) return invalidOutput();
      continue;
    }

    if (event.event === "result") {
      if (!isRecord(event.result) || event.result.status !== "SUCCESS") return invalidOutput();
      if (
        typeof event.result.response !== "string" ||
        event.result.response.length === 0 ||
        event.result.response.length > MAX_JSONL_BYTES ||
        event.result.num_turns !== 1
      ) return invalidOutput();
      text = event.result.response;
      usage = parseUsage(event.result.usage);
      terminalSeen = true;
      continue;
    }

    return invalidOutput();
  }

  if (!initialized || !terminalSeen || text === null) return invalidOutput();
  return { text, model: selectedModel, usage, finishReason: "stop" };
}
