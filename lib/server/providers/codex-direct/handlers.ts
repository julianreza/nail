import { isSameOriginRequest } from "../../auth/auth-service";
import { CodexDirectError, type CodexDirectErrorCode, type DirectAccountView } from "./types";

export interface DirectCodexService {
  account(): Promise<DirectAccountView>;
  start(sessionHash: string, signal: AbortSignal): Promise<{
    providerId: string;
    loginId: string;
    verificationUri: "https://auth.openai.com/codex/device";
    userCode: string;
    intervalSeconds: number;
    expiresAt: string;
  }>;
  poll(loginId: string, sessionHash: string, signal: AbortSignal): Promise<unknown>;
  cancel(loginId: string, sessionHash: string): Promise<{ cancelled: true }>;
  disconnect(expectedRevision: number): Promise<DirectAccountView>;
  refreshModels(expectedRevision: number, signal: AbortSignal): Promise<unknown>;
  selectModel(model: string, expectedRevision: number, signal: AbortSignal): Promise<DirectAccountView>;
}

interface AuthGuard {
  protectedResource(request: Request): Promise<Response>;
}

interface ServiceHandle {
  service: DirectCodexService;
  close(): Promise<void>;
}

export interface CodexDirectHandlerDependencies {
  auth: AuthGuard;
  getAppOrigin(): string | undefined;
  enabled(): boolean;
  getSessionHash(request: Request): string | null;
  createService(): Promise<ServiceHandle>;
}

const MAX_REQUEST_BYTES = 16 * 1024;
const ERROR_STATUS: Record<CodexDirectErrorCode, number> = {
  disabled: 503,
  invalid_request: 400,
  busy: 409,
  login_expired: 404,
  needs_login: 401,
  device_auth_unavailable: 422,
  rate_limited: 429,
  unsupported_protocol: 502,
  unavailable: 503,
  cancelled: 409,
  timeout: 504,
  output_limit: 502,
  budget_unenforceable: 422,
};

function json(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return Response.json(body, { status, headers });
}

function errorResponse(error: unknown): Response {
  if (error instanceof CodexDirectError) {
    return json({ error: error.message, code: error.code }, ERROR_STATUS[error.code]);
  }
  return json({ error: "Direct Codex service is unavailable", code: "unavailable" }, 503);
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.body) throw new CodexDirectError("invalid_request");
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
    throw new CodexDirectError("output_limit");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CodexDirectError("output_limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CodexDirectError) throw error;
    throw new CodexDirectError("invalid_request");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new CodexDirectError("invalid_request");
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CodexDirectError("invalid_request");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CodexDirectError("invalid_request");
  }
  return record;
}

export function createCodexDirectHandlers(dependencies: CodexDirectHandlerDependencies) {
  async function authorize(request: Request, mutation: boolean): Promise<Response | null> {
    const authorization = await dependencies.auth.protectedResource(request);
    if (!authorization.ok) return authorization;
    if (mutation) {
      const appOrigin = dependencies.getAppOrigin();
      if (!appOrigin || !isSameOriginRequest(request, appOrigin)) {
        return json({ error: "Invalid origin", code: "invalid_request" }, 403);
      }
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
        return json({ error: "Unsupported content type", code: "invalid_request" }, 415);
      }
    }
    return null;
  }

  async function withService<T>(operation: (service: DirectCodexService, sessionHash: string) => Promise<T>, request: Request): Promise<Response> {
    let handle: ServiceHandle | undefined;
    try {
      const sessionHash = dependencies.getSessionHash(request);
      if (!sessionHash || !/^[a-f0-9]{64}$/.test(sessionHash)) throw new CodexDirectError("needs_login");
      handle = await dependencies.createService();
      return json(await operation(handle.service, sessionHash));
    } catch (error) {
      return errorResponse(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async function mutation<T>(
    request: Request,
    fields: readonly string[],
    operation: (service: DirectCodexService, sessionHash: string, body: Record<string, unknown>) => Promise<T>,
    status = 200,
    extraHeaders?: HeadersInit,
  ): Promise<Response> {
    const denied = await authorize(request, true);
    if (denied) return denied;
    if (!dependencies.enabled()) return errorResponse(new CodexDirectError("disabled"));
    let body: Record<string, unknown>;
    try {
      body = exactObject(await readJson(request), fields);
    } catch (error) {
      if (error instanceof CodexDirectError && error.code === "output_limit") {
        return json({ error: "Request body is invalid or too large", code: "output_limit" }, 413);
      }
      return errorResponse(error);
    }
    const response = await withService((service, sessionHash) => operation(service, sessionHash, body), request);
    if (!response.ok) return response;
    if (status === 200 && !extraHeaders) return response;
    const headers = new Headers(response.headers);
    if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
    return new Response(response.body, { status, headers });
  }

  return {
    async account(request: Request): Promise<Response> {
      const denied = await authorize(request, false);
      if (denied) return denied;
      if (!dependencies.enabled()) {
        return json({ enabled: false, providerId: null, state: "not_configured", model: null, revision: 0, inferenceReady: false });
      }
      return withService((service) => service.account(), request);
    },

    start(request: Request): Promise<Response> {
      return mutation(request, [], (service, sessionHash) => service.start(sessionHash, request.signal), 201, {
        "referrer-policy": "no-referrer",
      });
    },

    poll(request: Request): Promise<Response> {
      return mutation(request, ["loginId"], (service, sessionHash, body) => {
        if (typeof body.loginId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.loginId)) throw new CodexDirectError("invalid_request");
        return service.poll(body.loginId, sessionHash, request.signal);
      });
    },

    cancel(request: Request): Promise<Response> {
      return mutation(request, ["loginId"], (service, sessionHash, body) => {
        if (typeof body.loginId !== "string" || !/^[a-f0-9-]{36}$/i.test(body.loginId)) throw new CodexDirectError("invalid_request");
        return service.cancel(body.loginId, sessionHash);
      });
    },

    disconnect(request: Request): Promise<Response> {
      return mutation(request, ["expectedRevision"], (service, _sessionHash, body) => {
        if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) throw new CodexDirectError("invalid_request");
        return service.disconnect(body.expectedRevision as number);
      });
    },

    models(request: Request): Promise<Response> {
      return mutation(request, ["expectedRevision"], (service, _sessionHash, body) => {
        if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) throw new CodexDirectError("invalid_request");
        return service.refreshModels(body.expectedRevision as number, request.signal);
      });
    },

    selectModel(request: Request): Promise<Response> {
      return mutation(request, ["model", "expectedRevision"], (service, _sessionHash, body) => {
        if (typeof body.model !== "string" || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) {
          throw new CodexDirectError("invalid_request");
        }
        return service.selectModel(body.model, body.expectedRevision as number, request.signal);
      });
    },
  };
}
