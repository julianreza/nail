import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import {
  SUBSCRIPTION_PROVIDER_KINDS,
  type ConnectionDiagnostic,
  type SubscriptionCompletion,
  type SubscriptionCompletionInput,
  type SubscriptionConnector,
  type SubscriptionProviderKind,
} from "../../domain/subscription-provider";
import {
  SUBSCRIPTION_PROVIDER_ERROR_CODES,
  SubscriptionProviderError,
} from "./subscription-errors";

const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 32768;
const BINDING_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function sendRequest(socketPath: string, request: unknown, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  if (signal.aborted) return Promise.reject(new SubscriptionProviderError("cancelled"));
  const requestBytes = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  if (requestBytes.byteLength > MAX_REQUEST_BYTES) {
    return Promise.reject(new SubscriptionProviderError("output_limit"));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let response = Buffer.alloc(0);
    let socket: Socket | undefined;
    const finish = (error?: SubscriptionProviderError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) rejectPromise(error);
      else resolvePromise(value);
      socket?.destroy();
    };
    const timeout = setTimeout(() => finish(new SubscriptionProviderError("timeout")), timeoutMs);
    const onAbort = () => finish(new SubscriptionProviderError("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      socket = createConnection({ path: socketPath });
    } catch {
      finish(new SubscriptionProviderError("unavailable"));
      return;
    }
    socket.setTimeout(timeoutMs, () => finish(new SubscriptionProviderError("timeout")));
    socket.on("connect", () => socket.write(requestBytes));
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, Buffer.from(chunk)]);
      if (response.byteLength > MAX_RESPONSE_BYTES) {
        finish(new SubscriptionProviderError("output_limit"));
        return;
      }
      const newline = response.indexOf(10);
      if (newline < 0) return;
      if (newline !== response.byteLength - 1) {
        finish(new SubscriptionProviderError("invalid_output"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.subarray(0, newline).toString("utf8"));
      } catch {
        finish(new SubscriptionProviderError("invalid_output"));
        return;
      }
      if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.ok !== "boolean") {
        finish(new SubscriptionProviderError("invalid_output"));
      } else if (parsed.ok) {
        if (!exactFields(parsed, ["v", "ok", "result"])) finish(new SubscriptionProviderError("invalid_output"));
        else finish(undefined, parsed.result);
      } else {
        if (
          !exactFields(parsed, ["v", "ok", "code"]) ||
          typeof parsed.code !== "string" ||
          !SUBSCRIPTION_PROVIDER_ERROR_CODES.includes(parsed.code as never)
        ) finish(new SubscriptionProviderError("invalid_output"));
        else finish(new SubscriptionProviderError(parsed.code as (typeof SUBSCRIPTION_PROVIDER_ERROR_CODES)[number]));
      }
    });
    socket.on("error", () => finish(new SubscriptionProviderError("unavailable")));
    socket.on("close", () => {
      if (!settled) finish(new SubscriptionProviderError("unavailable"));
    });
  });
}

function parseDiagnostic(value: unknown): ConnectionDiagnostic {
  if (
    !isRecord(value) || !exactFields(value, ["kind", "state", "reason", "model", "checkedAt"]) ||
    !SUBSCRIPTION_PROVIDER_KINDS.includes(value.kind as SubscriptionProviderKind) ||
    !["not_installed", "needs_login", "connected", "ready", "rate_limited", "unavailable", "unsupported"].includes(String(value.state)) ||
    (value.reason !== null && (typeof value.reason !== "string" || !/^[a-z0-9_]{1,64}$/.test(value.reason))) ||
    (value.model !== null && (typeof value.model !== "string" || !MODEL_ID.test(value.model))) ||
    typeof value.checkedAt !== "string" || Number.isNaN(Date.parse(value.checkedAt))
  ) throw new SubscriptionProviderError("invalid_output");
  return {
    kind: value.kind as SubscriptionProviderKind,
    state: value.state as ConnectionDiagnostic["state"],
    reason: value.reason as string | null,
    model: value.model as string | null,
    checkedAt: value.checkedAt,
  };
}

function parseCompletion(value: unknown): SubscriptionCompletion {
  if (
    !isRecord(value) || !exactFields(value, ["text", "model", "usage", "finishReason"]) ||
    typeof value.text !== "string" || value.text.length === 0 || Buffer.byteLength(value.text, "utf8") > MAX_RESPONSE_BYTES / 2 ||
    typeof value.model !== "string" || !MODEL_ID.test(value.model) ||
    value.finishReason !== "stop" || !isRecord(value.usage) ||
    !exactFields(value.usage, ["inputTokens", "outputTokens"]) ||
    (value.usage.inputTokens !== null && (!Number.isSafeInteger(value.usage.inputTokens) || (value.usage.inputTokens as number) < 0)) ||
    (value.usage.outputTokens !== null && (!Number.isSafeInteger(value.usage.outputTokens) || (value.usage.outputTokens as number) < 0))
  ) throw new SubscriptionProviderError("invalid_output");
  return {
    text: value.text,
    model: value.model,
    usage: {
      inputTokens: value.usage.inputTokens as number | null,
      outputTokens: value.usage.outputTokens as number | null,
    },
    finishReason: "stop",
  };
}

export function createSubscriptionConnectorClient(socketPath: string): SubscriptionConnector {
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath, "utf8") > 100) {
    throw new SubscriptionProviderError("invalid_binding");
  }
  return {
    async check(bindingId, signal) {
      if (!BINDING_ID.test(bindingId)) throw new SubscriptionProviderError("invalid_binding");
      return parseDiagnostic(await sendRequest(socketPath, { v: 1, op: "check", bindingId }, signal, 10_000));
    },
    async cancel(bindingId, signal) {
      if (!BINDING_ID.test(bindingId)) throw new SubscriptionProviderError("invalid_binding");
      const result = await sendRequest(socketPath, { v: 1, op: "cancel", bindingId }, signal, 5_000);
      if (result !== null) throw new SubscriptionProviderError("invalid_output");
    },
    async complete(input: SubscriptionCompletionInput, signal) {
      if (!BINDING_ID.test(input.bindingId) || !MODEL_ID.test(input.model)) {
        throw new SubscriptionProviderError("invalid_binding");
      }
      if (typeof input.prompt !== "string" || Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) {
        throw new SubscriptionProviderError("output_limit");
      }
      if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > MAX_OUTPUT_TOKENS) {
        throw new SubscriptionProviderError("budget_unenforceable");
      }
      const result = await sendRequest(socketPath, { v: 1, op: "complete", ...input }, signal, 125_000);
      return parseCompletion(result);
    },
  };
}
