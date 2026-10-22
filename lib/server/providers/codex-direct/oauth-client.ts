import { requestCodexJson } from "./http";
import { parseCodexModels, parseCodexTokens, parseDeviceGrant } from "./protocol";
import { CodexDirectError, type CodexDirectErrorCode, type CodexModel, type CodexTokens, type DeviceGrant } from "./types";

export interface CodexOAuthClientOptions {
  clientId: string;
  clientVersion: string;
  fetcher: typeof fetch;
  clock: () => number;
}

function safeProtocolError(): CodexDirectError {
  return new CodexDirectError("unsupported_protocol");
}

function mapStatus(status: number): CodexDirectErrorCode {
  if (status === 401 || status === 403) return "needs_login";
  if (status === 404) return "device_auth_unavailable";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "unsupported_protocol";
}

function errorCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function createCodexOAuthClient(options: CodexOAuthClientOptions) {
  const request = (operation: "start" | "poll" | "exchange" | "refresh" | "models", payload: Record<string, string>, signal: AbortSignal, tokens?: CodexTokens) =>
    requestCodexJson(operation, payload, {
      fetcher: options.fetcher,
      signal,
      clientId: options.clientId,
      clientVersion: options.clientVersion,
      ...(tokens ? { tokens } : {}),
    });

  return {
    async start(signal: AbortSignal): Promise<DeviceGrant> {
      const result = await request("start", {}, signal);
      if (result.status < 200 || result.status >= 300) throw new CodexDirectError(mapStatus(result.status));
      try {
        return parseDeviceGrant(result.value, options.clock());
      } catch {
        throw safeProtocolError();
      }
    },

    async poll(
      grant: DeviceGrant,
      signal: AbortSignal,
    ): Promise<{ state: "pending"; slowDown: boolean } | { state: "code"; code: string; verifier: string }> {
      if (grant.expiresAt <= options.clock()) throw new CodexDirectError("login_expired");
      const result = await request("poll", { deviceAuthId: grant.deviceAuthId, userCode: grant.userCode }, signal);
      if (result.status === 403 || result.status === 404) return { state: "pending", slowDown: false };
      const vendorCode = errorCode(result.value);
      if (vendorCode === "slow_down") return { state: "pending", slowDown: true };
      if (vendorCode === "deviceauth_authorization_pending") return { state: "pending", slowDown: false };
      if (result.status === 400 || result.status === 401 || result.status === 403) {
        if (vendorCode === "invalid_grant" || vendorCode === "access_denied" || vendorCode === "expired_token") {
          throw new CodexDirectError("needs_login");
        }
        throw safeProtocolError();
      }
      if (result.status < 200 || result.status >= 300) throw new CodexDirectError(mapStatus(result.status));
      if (typeof result.value !== "object" || result.value === null || Array.isArray(result.value)) throw safeProtocolError();
      const value = result.value as Record<string, unknown>;
      const code = value.authorization_code;
      const verifier = value.code_verifier;
      if (
        typeof code !== "string" || !/^[A-Za-z0-9._~-]{1,16384}$/.test(code) ||
        typeof verifier !== "string" || !/^[A-Za-z0-9._~-]{1,16384}$/.test(verifier)
      ) throw safeProtocolError();
      return { state: "code", code, verifier };
    },

    async exchange(code: string, verifier: string, signal: AbortSignal): Promise<CodexTokens> {
      if (!code || Buffer.byteLength(code) > 16 * 1024 || !verifier || Buffer.byteLength(verifier) > 16 * 1024) {
        throw new CodexDirectError("invalid_request");
      }
      const result = await request("exchange", { code, codeVerifier: verifier }, signal);
      if (result.status === 400 || result.status === 401) {
        const codeValue = errorCode(result.value);
        throw new CodexDirectError(codeValue === "invalid_grant" ? "needs_login" : "unsupported_protocol");
      }
      if (result.status < 200 || result.status >= 300) throw new CodexDirectError(mapStatus(result.status));
      try {
        return parseCodexTokens(result.value, options.clock());
      } catch {
        throw safeProtocolError();
      }
    },

    async refresh(tokens: CodexTokens, signal: AbortSignal): Promise<CodexTokens> {
      const result = await request("refresh", { refreshToken: tokens.refreshToken }, signal);
      if (result.status === 400 || result.status === 401) {
        const codeValue = errorCode(result.value);
        throw new CodexDirectError(codeValue === "invalid_grant" || codeValue === "expired_token" ? "needs_login" : "unsupported_protocol");
      }
      if (result.status < 200 || result.status >= 300) throw new CodexDirectError(mapStatus(result.status));
      let refreshed: CodexTokens;
      try {
        refreshed = parseCodexTokens(result.value, options.clock());
      } catch {
        throw safeProtocolError();
      }
      if (refreshed.accountId !== tokens.accountId) throw safeProtocolError();
      return refreshed;
    },

    async models(tokens: CodexTokens, signal: AbortSignal): Promise<CodexModel[]> {
      const result = await request("models", {}, signal, tokens);
      if (result.status === 401 || result.status === 403) throw new CodexDirectError("needs_login");
      if (result.status < 200 || result.status >= 300) throw new CodexDirectError(mapStatus(result.status));
      try {
        return parseCodexModels(result.value);
      } catch {
        throw safeProtocolError();
      }
    },
  };
}
