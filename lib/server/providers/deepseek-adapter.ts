import type { DatabaseSync } from "node:sqlite";
import { createRepositories } from "../db/repositories";
import { EncryptedSecretStore } from "./secret-store";
import {
  completeProviderUsage,
  getRemainingUsageBudget,
  reserveProviderRequest,
  UsageBudgetExceededError,
} from "./usage-budget";

const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_TOOLS = 64;

export interface DeepSeekMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
}

export interface DeepSeekTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekRequest {
  runId: string;
  providerId: string;
  messages: DeepSeekMessage[];
  maxOutputTokens: number;
  tools?: DeepSeekTool[];
  stream?: boolean;
  signal?: AbortSignal;
}

export interface DeepSeekCompletion {
  kind: "complete";
  id: string;
  model: string;
  content: string | null;
  toolCalls: DeepSeekToolCall[];
  finishReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  reservationId: string;
}

export interface DeepSeekStream {
  kind: "stream";
  model: string;
  stream: ReadableStream<Uint8Array>;
  reservationId: string;
}

export type DeepSeekResult = DeepSeekCompletion | DeepSeekStream;

export class ProviderCapabilityError extends Error {
  constructor(capability: string) {
    super(`Provider does not support required capability: ${capability}`);
    this.name = "ProviderCapabilityError";
  }
}

export class ProviderConfigurationError extends Error {
  constructor() {
    super("Provider API-key configuration is incomplete");
    this.name = "ProviderConfigurationError";
  }
}

export class ProviderAuthenticationError extends Error {
  constructor() {
    super("Provider authentication failed");
    this.name = "ProviderAuthenticationError";
  }
}

export class ProviderRateLimitError extends Error {
  constructor() {
    super("Provider rate limit reached; no automatic fallback was attempted");
    this.name = "ProviderRateLimitError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor() {
    super("Provider is unavailable; no automatic fallback was attempted");
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderRequestError extends Error {
  constructor(public readonly status: number) {
    super(`Provider request failed with status ${status}`);
    this.name = "ProviderRequestError";
  }
}

export class ProviderResponseError extends Error {
  constructor() {
    super("Provider returned an invalid or unsupported response");
    this.name = "ProviderResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseToolCalls(value: unknown): DeepSeekToolCall[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_TOOLS) throw new ProviderResponseError();
  return value.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || item.type !== "function") {
      throw new ProviderResponseError();
    }
    const fn = item.function;
    if (
      !isRecord(fn) ||
      typeof fn.name !== "string" ||
      typeof fn.arguments !== "string"
    ) {
      throw new ProviderResponseError();
    }
    return {
      id: item.id,
      type: "function",
      function: {
        name: fn.name,
        arguments: fn.arguments,
      },
    };
  });
}

function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

function validateRequest(request: DeepSeekRequest): void {
  if (
    !Array.isArray(request.messages) ||
    request.messages.length < 1 ||
    request.messages.length > MAX_MESSAGES
  ) {
    throw new ProviderRequestError(400);
  }
  for (const message of request.messages) {
    if (
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      (message.content !== null &&
        (typeof message.content !== "string" || message.content.length > MAX_MESSAGE_CHARS))
    ) {
      throw new ProviderRequestError(400);
    }
  }
  if (request.tools && !Array.isArray(request.tools)) throw new ProviderRequestError(400);
  if (request.tools && request.tools.length > MAX_TOOLS) throw new ProviderRequestError(400);
  for (const tool of request.tools ?? []) {
    if (
      tool.type !== "function" ||
      !tool.function ||
      typeof tool.function.name !== "string" ||
      !isRecord(tool.function.parameters)
    ) {
      throw new ProviderRequestError(400);
    }
  }
}

function parseUsage(value: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!isRecord(value)) return null;
  const inputTokens = requireNonnegativeInteger(value.prompt_tokens ?? value.input_tokens);
  const outputTokens = requireNonnegativeInteger(value.completion_tokens ?? value.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  return { inputTokens, outputTokens };
}

function streamChunk(value: string): { usage: { inputTokens: number; outputTokens: number } | null; toolCallDelta: boolean } {
  if (!value.startsWith("data:")) return { usage: null, toolCallDelta: false };
  const data = value.slice(5).trim();
  if (!data || data === "[DONE]") return { usage: null, toolCallDelta: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ProviderResponseError();
  }
  if (!isRecord(parsed)) throw new ProviderResponseError();
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const toolCallDelta = choices.some(
    (choice) => isRecord(choice) && isRecord(choice.delta) &&
      Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length > 0,
  );
  return { usage: parseUsage(parsed.usage), toolCallDelta };
}

function usageTrackingStream(
  source: ReadableStream<Uint8Array>,
  secret: string,
  finalize: (usage: { inputTokens: number; outputTokens: number } | null) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pendingLines = "";
  let pendingRedaction = "";
  let finalUsage: { inputTokens: number; outputTokens: number } | null = null;
  let finalized = false;

  function redactChunk(text: string, final: boolean): string {
    const combined = pendingRedaction + text;
    let safeLength = final
      ? combined.length
      : Math.max(0, combined.length - Math.max(1, secret.length - 1));
    if (!final && secret.length > 0) {
      const firstCandidate = Math.max(0, safeLength - secret.length + 1);
      for (let start = firstCandidate; start < safeLength; start += 1) {
        const partial = combined.slice(start, safeLength);
        if (partial.length < secret.length && secret.startsWith(partial)) {
          safeLength = start;
          break;
        }
      }
    }
    const safe = combined.slice(0, safeLength);
    pendingRedaction = combined.slice(safeLength);
    return redactSecret(safe, secret);
  }

  function observeLines(text: string, final: boolean): void {
    pendingLines += text;
    const lines = pendingLines.split(/\r?\n/);
    pendingLines = final ? "" : lines.pop() ?? "";
    for (const line of lines) {
      const chunk = streamChunk(line);
      if (chunk.toolCallDelta) throw new ProviderCapabilityError("streaming tool calls");
      if (chunk.usage) finalUsage = chunk.usage;
    }
    if (final && pendingLines.length > 0) {
      const chunk = streamChunk(pendingLines);
      if (chunk.toolCallDelta) throw new ProviderCapabilityError("streaming tool calls");
      if (chunk.usage) finalUsage = chunk.usage;
      pendingLines = "";
    }
  }

  function finalizeOnce(): void {
    if (finalized) return;
    finalized = true;
    finalize(finalUsage);
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          const tail = decoder.decode();
          observeLines(tail, true);
          const last = redactChunk("", true);
          finalizeOnce();
          if (last) controller.enqueue(encoder.encode(last));
          controller.close();
          return;
        }
        const text = decoder.decode(result.value, { stream: true });
        observeLines(text, false);
        const safe = redactChunk(text, false);
        if (safe) controller.enqueue(encoder.encode(safe));
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        try {
          finalizeOnce();
        } catch {
          // Keep the original stream error; reserved output remains conservatively charged.
        }
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      finalizeOnce();
    },
  });
}

export class DeepSeekAdapter {
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly options: {
      database: DatabaseSync;
      secretStore: EncryptedSecretStore;
      fetcher?: typeof fetch;
    },
  ) {
    this.fetcher = options.fetcher ?? globalThis.fetch;
  }

  async complete(request: DeepSeekRequest): Promise<DeepSeekResult> {
    validateRequest(request);
    const repositories = createRepositories(this.options.database);
    const provider = repositories.providers.getById(request.providerId);
    if (
      !provider ||
      provider.name.toLowerCase() !== "deepseek" ||
      provider.authMode !== "api_key" ||
      !provider.secretReference ||
      !provider.model
    ) {
      throw new ProviderConfigurationError();
    }
    if (provider.status !== "ready") throw new ProviderUnavailableError();
    if (request.tools?.length && !provider.capabilities.includes("tools")) {
      throw new ProviderCapabilityError("tools");
    }
    if (request.stream && !provider.capabilities.includes("streaming")) {
      throw new ProviderCapabilityError("streaming");
    }
    if (request.stream && request.tools?.length) {
      throw new ProviderCapabilityError("streaming tool calls");
    }
    if (request.tools?.length && getRemainingUsageBudget(this.options.database, request.runId).toolCalls < 1) {
      throw new UsageBudgetExceededError("tool_calls");
    }

    const apiKey = this.options.secretStore.get(provider.secretReference);
    const reservation = reserveProviderRequest(this.options.database, {
      runId: request.runId,
      providerId: provider.id,
      maxOutputTokens: request.maxOutputTokens,
    });
    const body = {
      model: provider.model,
      messages: request.messages,
      max_tokens: request.maxOutputTokens,
      stream: request.stream === true,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.stream ? { stream_options: { include_usage: true } } : {}),
    };

    let response: Response;
    try {
      response = await this.fetcher(DEEPSEEK_CHAT_COMPLETIONS_URL, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: redactSecret(JSON.stringify(body), apiKey),
      });
    } catch {
      repositories.providers.updateStatus(provider.id, "unavailable");
      throw new ProviderUnavailableError();
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        repositories.providers.updateStatus(provider.id, "needs_login");
        throw new ProviderAuthenticationError();
      }
      if (response.status === 429) {
        repositories.providers.updateStatus(provider.id, "rate_limited");
        throw new ProviderRateLimitError();
      }
      if (response.status >= 500) {
        repositories.providers.updateStatus(provider.id, "unavailable");
        throw new ProviderUnavailableError();
      }
      throw new ProviderRequestError(response.status);
    }
    repositories.providers.updateStatus(provider.id, "ready");

    if (request.stream) {
      if (!response.body) {
        repositories.providers.updateStatus(provider.id, "unavailable");
        throw new ProviderResponseError();
      }
      const stream = usageTrackingStream(response.body, apiKey, (usage) => {
        completeProviderUsage(this.options.database, reservation.id, {
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          toolCalls: 0,
        });
      });
      return {
        kind: "stream",
        model: provider.model,
        stream,
        reservationId: reservation.id,
      };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      repositories.providers.updateStatus(provider.id, "unavailable");
      throw new ProviderResponseError();
    }
    if (!isRecord(raw) || typeof raw.id !== "string" || !Array.isArray(raw.choices)) {
      repositories.providers.updateStatus(provider.id, "unavailable");
      throw new ProviderResponseError();
    }
    const choice = raw.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message)) {
      repositories.providers.updateStatus(provider.id, "unavailable");
      throw new ProviderResponseError();
    }
    const message = choice.message;
    if (message.role !== "assistant" || (message.content !== null && typeof message.content !== "string")) {
      repositories.providers.updateStatus(provider.id, "unavailable");
      throw new ProviderResponseError();
    }
    let toolCalls: DeepSeekToolCall[];
    try {
      toolCalls = parseToolCalls(message.tool_calls);
    } catch {
      repositories.providers.updateStatus(provider.id, "unavailable");
      throw new ProviderResponseError();
    }
    if (toolCalls.length > 0 && !request.tools?.length) {
      repositories.providers.updateStatus(provider.id, "unavailable");
      throw new ProviderResponseError();
    }

    const usage = parseUsage(raw.usage);
    const budgetResult = completeProviderUsage(this.options.database, reservation.id, {
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      toolCalls: toolCalls.length,
    });
    if (!budgetResult.toolCallsAllowed) {
      throw new UsageBudgetExceededError("tool_calls");
    }

    const content = typeof message.content === "string"
      ? redactSecret(message.content, apiKey)
      : null;
    const safeToolCalls = toolCalls.map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: redactSecret(call.function.arguments, apiKey),
      },
    }));
    return {
      kind: "complete",
      id: raw.id,
      model: typeof raw.model === "string" ? raw.model : provider.model,
      content,
      toolCalls: safeToolCalls,
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      usage,
      reservationId: reservation.id,
    };
  }
}
