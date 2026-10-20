import { chmodSync, lstatSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, dirname } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import {
  SUBSCRIPTION_PROVIDER_KINDS,
  type ConnectionDiagnostic,
  type SubscriptionCompletion,
  type SubscriptionConnector,
  type SubscriptionProviderKind,
} from "../../lib/domain/subscription-provider";
import { SubscriptionProviderError } from "../../lib/server/providers/subscription-errors";
import type { ConnectorConfig, ConnectorBindingConfig } from "./connector-config";
import { AntigravitySubscriptionAdapter } from "./antigravity-adapter";
import { ClaudeSubscriptionAdapter } from "./claude-adapter";
import { CodexSubscriptionAdapter } from "./codex-adapter";

const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_OUTPUT_TOKENS = 32768;
const BINDING_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_REASON = /^[a-z0-9_]{1,64}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface WireRequest {
  v: 1;
  op: "check" | "cancel" | "complete";
  bindingId: string;
  prompt?: string;
  model?: string;
  maxOutputTokens?: number;
}

interface ActiveInvocation {
  controller: AbortController;
  promise: Promise<unknown>;
}

export interface StartSubscriptionConnectorOptions {
  config: ConnectorConfig;
  adapters?: Partial<Record<SubscriptionProviderKind, SubscriptionConnector>>;
}

export interface SubscriptionConnectorServerHandle {
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function boundedResponse(value: unknown): Buffer {
  const line = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (line.byteLength > MAX_RESPONSE_BYTES) {
    return Buffer.from(`${JSON.stringify({ v: 1, ok: false, code: "output_limit" })}\n`);
  }
  return line;
}

function defaultAdapter(binding: ConnectorBindingConfig): SubscriptionConnector {
  switch (binding.kind) {
    case "codex": return new CodexSubscriptionAdapter(binding);
    case "antigravity": return new AntigravitySubscriptionAdapter(binding);
    case "claude": return new ClaudeSubscriptionAdapter(binding);
  }
}

function validateDiagnostic(value: ConnectionDiagnostic, binding: ConnectorBindingConfig): ConnectionDiagnostic {
  if (
    value.kind !== binding.kind ||
    !["not_installed", "needs_login", "connected", "ready", "rate_limited", "unavailable", "unsupported"].includes(value.state) ||
    (value.reason !== null && (typeof value.reason !== "string" || !SAFE_REASON.test(value.reason))) ||
    (value.model !== null && value.model !== binding.model) ||
    typeof value.checkedAt !== "string" ||
    Number.isNaN(Date.parse(value.checkedAt))
  ) throw new SubscriptionProviderError("invalid_output");
  return {
    kind: value.kind,
    state: value.state,
    reason: value.reason,
    model: value.model,
    checkedAt: value.checkedAt,
  };
}

function validateCompletion(value: SubscriptionCompletion, binding: ConnectorBindingConfig): SubscriptionCompletion {
  if (
    typeof value.text !== "string" || value.text.length === 0 || Buffer.byteLength(value.text, "utf8") > MAX_RESPONSE_BYTES / 2 ||
    value.model !== binding.model ||
    value.finishReason !== "stop" ||
    !value.usage ||
    (value.usage.inputTokens !== null && (!Number.isSafeInteger(value.usage.inputTokens) || value.usage.inputTokens < 0)) ||
    (value.usage.outputTokens !== null && (!Number.isSafeInteger(value.usage.outputTokens) || value.usage.outputTokens < 0))
  ) throw new SubscriptionProviderError("invalid_output");
  return {
    text: value.text,
    model: value.model,
    usage: { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens },
    finishReason: "stop",
  };
}

function parseRequest(bytes: Buffer): WireRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SubscriptionProviderError("invalid_binding");
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.op !== "string" || typeof parsed.bindingId !== "string" || !BINDING_ID.test(parsed.bindingId)) {
    throw new SubscriptionProviderError("invalid_binding");
  }
  if (parsed.op === "check" || parsed.op === "cancel") {
    if (!exactFields(parsed, ["bindingId", "op", "v"])) throw new SubscriptionProviderError("invalid_binding");
    return parsed as unknown as WireRequest;
  }
  if (parsed.op !== "complete" || !exactFields(parsed, ["bindingId", "maxOutputTokens", "model", "op", "prompt", "v"])) {
    throw new SubscriptionProviderError("invalid_binding");
  }
  if (typeof parsed.prompt !== "string") throw new SubscriptionProviderError("invalid_binding");
  if (Buffer.byteLength(parsed.prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new SubscriptionProviderError("output_limit");
  }
  if (typeof parsed.model !== "string") throw new SubscriptionProviderError("invalid_binding");
  if (!MODEL_ID.test(parsed.model)) throw new SubscriptionProviderError("invalid_model");
  if (
    !Number.isSafeInteger(parsed.maxOutputTokens) ||
    (parsed.maxOutputTokens as number) < 1 || (parsed.maxOutputTokens as number) > MAX_OUTPUT_TOKENS
  ) throw new SubscriptionProviderError("budget_unenforceable");
  return parsed as unknown as WireRequest;
}

export async function startSubscriptionConnectorServer(
  options: StartSubscriptionConnectorOptions,
): Promise<SubscriptionConnectorServerHandle> {
  const { socketPath, bindings } = options.config;
  if (!isAbsolute(socketPath) || Buffer.byteLength(socketPath, "utf8") > 100) {
    throw new SubscriptionProviderError("invalid_binding");
  }
  let parent;
  try {
    parent = lstatSync(dirname(socketPath));
  } catch {
    throw new SubscriptionProviderError("invalid_binding");
  }
  const uid = process.getuid?.();
  if (
    parent.isSymbolicLink() || !parent.isDirectory() || (uid !== undefined && parent.uid !== uid) ||
    (parent.mode & 0o077) !== 0
  ) throw new SubscriptionProviderError("invalid_binding");
  try {
    lstatSync(socketPath);
    throw new SubscriptionProviderError("invalid_binding");
  } catch (error) {
    if (error instanceof SubscriptionProviderError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SubscriptionProviderError("invalid_binding");
  }
  if (
    bindings.length > 3 ||
    new Set(bindings.map((binding) => binding.bindingId)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.kind)).size !== bindings.length
  ) {
    throw new SubscriptionProviderError("invalid_binding");
  }
  const bindingMap = new Map(bindings.map((binding) => [binding.bindingId, binding]));
  const adapters = new Map<SubscriptionProviderKind, SubscriptionConnector>();
  for (const kind of SUBSCRIPTION_PROVIDER_KINDS) {
    const binding = bindings.find((candidate) => candidate.kind === kind);
    if (binding) adapters.set(kind, options.adapters?.[kind] ?? defaultAdapter(binding));
  }
  const active = new Map<string, ActiveInvocation>();
  let shuttingDown = false;
  const server: Server = createServer((socket) => {
    handleSocket(socket, bindingMap, adapters, active, () => shuttingDown);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = () => rejectPromise(new SubscriptionProviderError("unavailable"));
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.removeListener("error", onError);
      try {
        chmodSync(socketPath, 0o600);
        resolvePromise();
      } catch {
        rejectPromise(new SubscriptionProviderError("unavailable"));
      }
    });
  });
  const socketStat = statSync(socketPath);

  return {
    async close() {
      shuttingDown = true;
      for (const invocation of active.values()) invocation.controller.abort();
      await Promise.allSettled([...active.values()].map((invocation) => invocation.promise));
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => error ? rejectPromise(error) : resolvePromise());
      });
      try {
        const current = lstatSync(socketPath);
        if (current.isSocket() && current.dev === socketStat.dev && current.ino === socketStat.ino) unlinkSync(socketPath);
      } catch {
        // The socket was already removed; do not delete any replacement path.
      }
    },
  };
}

function handleSocket(
  socket: Socket,
  bindings: Map<string, ConnectorBindingConfig>,
  adapters: Map<SubscriptionProviderKind, SubscriptionConnector>,
  active: Map<string, ActiveInvocation>,
  isShuttingDown: () => boolean,
): void {
  const requestController = new AbortController();
  let bytes = Buffer.alloc(0);
  let processing = false;
  let responded = false;
  const timeout = setTimeout(() => {
    requestController.abort();
    respondError(new SubscriptionProviderError("timeout"));
  }, 125_000);
  const respond = (value: unknown) => {
    if (responded || socket.destroyed) return;
    responded = true;
    clearTimeout(timeout);
    socket.end(boundedResponse(value));
  };
  const respondError = (error: unknown) => respond({ v: 1, ok: false, code: error instanceof SubscriptionProviderError ? error.code : "unavailable" });

  socket.on("close", () => {
    clearTimeout(timeout);
    requestController.abort();
  });
  socket.on("error", () => {
    clearTimeout(timeout);
    requestController.abort();
  });
  socket.on("data", (chunk) => {
    if (processing || responded) return;
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
    if (bytes.byteLength > MAX_REQUEST_BYTES) {
      processing = true;
      respondError(new SubscriptionProviderError("output_limit"));
      return;
    }
    const newline = bytes.indexOf(10);
    if (newline < 0) return;
    if (newline !== bytes.byteLength - 1) {
      processing = true;
      respondError(new SubscriptionProviderError("invalid_binding"));
      return;
    }
    processing = true;
    const requestBytes = bytes.subarray(0, newline);
    void dispatchRequest(requestBytes, requestController.signal, bindings, adapters, active, isShuttingDown)
      .then((result) => respond({ v: 1, ok: true, result }))
      .catch(respondError);
  });
}

async function dispatchRequest(
  bytes: Buffer,
  signal: AbortSignal,
  bindings: Map<string, ConnectorBindingConfig>,
  adapters: Map<SubscriptionProviderKind, SubscriptionConnector>,
  active: Map<string, ActiveInvocation>,
  isShuttingDown: () => boolean,
): Promise<ConnectionDiagnostic | SubscriptionCompletion | null> {
  if (isShuttingDown()) throw new SubscriptionProviderError("unavailable");
  const request = parseRequest(bytes);
  const binding = bindings.get(request.bindingId);
  if (!binding || !binding.enabled) throw new SubscriptionProviderError("invalid_binding");
  const adapter = adapters.get(binding.kind);
  if (!adapter) throw new SubscriptionProviderError("not_installed");

  if (request.op === "check") {
    const diagnostic = await runBoundInvocation(
      binding.bindingId,
      signal,
      active,
      (invocationSignal) => adapter.check(binding.bindingId, invocationSignal),
    );
    return validateDiagnostic(diagnostic as ConnectionDiagnostic, binding);
  }
  if (request.op === "cancel") {
    const running = active.get(binding.bindingId);
    if (running) {
      running.controller.abort();
      await running.promise.catch(() => undefined);
    }
    return null;
  }
  if (request.model !== binding.model) throw new SubscriptionProviderError("invalid_model");
  const completion = await runBoundInvocation(
    binding.bindingId,
    signal,
    active,
    (invocationSignal) => adapter.complete({
      bindingId: binding.bindingId,
      prompt: request.prompt!,
      model: request.model!,
      maxOutputTokens: request.maxOutputTokens!,
    }, invocationSignal),
  );
  return validateCompletion(completion as SubscriptionCompletion, binding);
}

async function runBoundInvocation<T>(
  bindingId: string,
  callerSignal: AbortSignal,
  active: Map<string, ActiveInvocation>,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (callerSignal.aborted) throw new SubscriptionProviderError("cancelled");
  if (active.has(bindingId)) throw new SubscriptionProviderError("busy");
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  callerSignal.addEventListener("abort", abortFromCaller, { once: true });
  const promise = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new SubscriptionProviderError("cancelled");
    return operation(controller.signal);
  });
  const invocation: ActiveInvocation = { controller, promise };
  active.set(bindingId, invocation);
  try {
    return await promise;
  } catch (error) {
    if (controller.signal.aborted) throw new SubscriptionProviderError("cancelled");
    throw error;
  } finally {
    callerSignal.removeEventListener("abort", abortFromCaller);
    if (active.get(bindingId) === invocation) active.delete(bindingId);
  }
}
