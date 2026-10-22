import type { CodexTokens } from "./types";
import { CodexDirectError } from "./types";

export type CodexJsonOperation = "start" | "poll" | "exchange" | "refresh" | "models";

export interface CodexJsonDependencies {
  fetcher: typeof fetch;
  signal: AbortSignal;
  clientId: string;
  clientVersion: string;
  tokens?: CodexTokens;
}

const AUTH_ORIGIN = "https://auth.openai.com";
const CODEX_ORIGIN = "https://chatgpt.com";
const JSON_LIMIT = 256 * 1024;
const CATALOG_LIMIT = 1024 * 1024;
const SECRET_FIELD_LIMIT = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const SAFE_VENDOR_ERRORS = new Set([
  "deviceauth_authorization_pending",
  "slow_down",
  "invalid_grant",
  "expired_token",
  "invalid_request",
  "access_denied",
]);

const EXPECTED_FIELDS: Record<CodexJsonOperation, readonly string[]> = {
  start: [],
  poll: ["deviceAuthId", "userCode"],
  exchange: ["code", "codeVerifier"],
  refresh: ["refreshToken"],
  models: [],
};

function invalidRequest(): never {
  throw new CodexDirectError("invalid_request");
}

function validateClient(clientId: string, clientVersion: string): void {
  if (
    typeof clientId !== "string" || clientId.length < 1 || clientId.length > 200 ||
    !/^[\x21-\x7e]+$/.test(clientId) || /\s/.test(clientId) ||
    typeof clientVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(clientVersion)
  ) invalidRequest();
}

function validatePayload(operation: CodexJsonOperation, payload: Record<string, string>): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalidRequest();
  const keys = Object.keys(payload).sort();
  const expected = [...EXPECTED_FIELDS[operation]].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalidRequest();
  for (const value of Object.values(payload)) {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > SECRET_FIELD_LIMIT || value.includes("\0")) {
      invalidRequest();
    }
  }
  if (operation === "poll" && (!/^[A-Za-z0-9_-]{1,256}$/.test(payload.deviceAuthId) || !/^[A-Za-z0-9-]{4,32}$/.test(payload.userCode))) {
    invalidRequest();
  }
  if (operation === "exchange" && (!/^[A-Za-z0-9._~-]+$/.test(payload.code) || !/^[A-Za-z0-9._~-]+$/.test(payload.codeVerifier))) {
    invalidRequest();
  }
}

function requestFor(
  operation: CodexJsonOperation,
  payload: Record<string, string>,
  dependencies: CodexJsonDependencies,
): { url: string; init: RequestInit; maxBytes: number } {
  const headers = new Headers({ accept: "application/json" });
  let url = "";
  let method = "POST";
  let body: string | undefined;
  if (operation === "start") {
    url = `${AUTH_ORIGIN}/api/accounts/deviceauth/usercode`;
    headers.set("content-type", "application/json");
    body = JSON.stringify({ client_id: dependencies.clientId });
  } else if (operation === "poll") {
    url = `${AUTH_ORIGIN}/api/accounts/deviceauth/token`;
    headers.set("content-type", "application/json");
    body = JSON.stringify({ device_auth_id: payload.deviceAuthId, user_code: payload.userCode });
  } else if (operation === "exchange") {
    url = `${AUTH_ORIGIN}/oauth/token`;
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: dependencies.clientId,
      code: payload.code,
      code_verifier: payload.codeVerifier,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
    }).toString();
  } else if (operation === "refresh") {
    url = `${AUTH_ORIGIN}/oauth/token`;
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: dependencies.clientId,
      refresh_token: payload.refreshToken,
    }).toString();
  } else {
    if (!dependencies.tokens) invalidRequest();
    const models = new URL("/backend-api/codex/models", CODEX_ORIGIN);
    models.searchParams.set("client_version", dependencies.clientVersion);
    url = models.toString();
    method = "GET";
    headers.set("authorization", `Bearer ${dependencies.tokens.accessToken}`);
    headers.set("chatgpt-account-id", dependencies.tokens.accountId);
    headers.set("originator", "nail");
  }
  return {
    url,
    init: { method, headers, body, signal: dependencies.signal, redirect: "error", credentials: "omit", cache: "no-store" },
    maxBytes: operation === "models" ? CATALOG_LIMIT : JSON_LIMIT,
  };
}

function abortError(timedOut: boolean): CodexDirectError {
  return new CodexDirectError(timedOut ? "timeout" : "cancelled");
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal, timedOut: () => boolean): Promise<T> {
  if (signal.aborted) throw abortError(timedOut());
  let removeListener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortError(timedOut()));
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } catch (error) {
    if (signal.aborted) throw abortError(timedOut());
    if (error instanceof CodexDirectError) throw error;
    throw new CodexDirectError("unavailable");
  } finally {
    removeListener();
  }
}

async function readBoundedJson(
  response: Response,
  limit: number,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new CodexDirectError("unsupported_protocol");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const result = await raceAbort(reader.read(), signal, timedOut);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new CodexDirectError("output_limit");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CodexDirectError) throw error;
    throw new CodexDirectError("unsupported_protocol");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new CodexDirectError("unsupported_protocol");
  }
}

function safeErrorProjection(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string" && SAFE_VENDOR_ERRORS.has(error)) return { error };
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string" && SAFE_VENDOR_ERRORS.has(code)) return { error: { code } };
  }
  return null;
}

export async function requestCodexJson(
  operation: CodexJsonOperation,
  payload: Record<string, string>,
  dependencies: CodexJsonDependencies,
): Promise<{ status: number; value: unknown }> {
  validateClient(dependencies.clientId, dependencies.clientVersion);
  validatePayload(operation, payload);
  if (dependencies.signal.aborted) throw new CodexDirectError("cancelled");
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const abortCaller = () => controller.abort();
  dependencies.signal.addEventListener("abort", abortCaller, { once: true });
  const timedOutCheck = () => timedOut;
  const request = requestFor(operation, payload, dependencies);
  request.init.signal = controller.signal;
  try {
    let response: Response;
    try {
      response = await raceAbort(Promise.resolve(dependencies.fetcher(request.url, request.init)), controller.signal, timedOutCheck);
    } catch (error) {
      if (error instanceof CodexDirectError) throw error;
      if (controller.signal.aborted) throw abortError(timedOutCheck());
      throw new CodexDirectError("unavailable");
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodexDirectError("unsupported_protocol");
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodexDirectError("rate_limited");
    }
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodexDirectError("unavailable");
    }
    if (operation === "start" && response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new CodexDirectError("device_auth_unavailable");
    }
    if (operation === "poll" && (response.status === 403 || response.status === 404)) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, value: null };
    }
    const value = await readBoundedJson(response, request.maxBytes, controller.signal, timedOutCheck);
    if (!response.ok) return { status: response.status, value: safeErrorProjection(value) };
    return { status: response.status, value };
  } finally {
    clearTimeout(timeout);
    dependencies.signal.removeEventListener("abort", abortCaller);
  }
}
