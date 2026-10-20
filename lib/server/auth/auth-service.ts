import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PASSWORD_BYTES = 64;
const DEFAULT_FAILURE_LIMIT = 5;
const DEFAULT_WINDOW_SECONDS = 900;
const DEFAULT_SESSION_TTL_SECONDS = 28_800;
export const AUTH_SESSION_COOKIE_NAME = "nail_session";
const SESSION_COOKIE = AUTH_SESSION_COOKIE_NAME;

export interface AuthConfig {
  ownerPasswordHash: string;
  sessionSecret: string;
  appOrigin: string;
  secureCookies: boolean;
  sessionTtlSeconds?: number;
  loginFailureLimit?: number;
  loginWindowSeconds?: number;
}

type Clock = () => number;

interface FailureWindow {
  count: number;
  startedAt: number;
}

export interface AuthState {
  failures: FailureWindow;
  activeSessions: Set<string>;
}

export function createAuthState(): AuthState {
  return { failures: { count: 0, startedAt: 0 }, activeSessions: new Set() };
}

const authGlobal = globalThis as typeof globalThis & {
  __nailAuthState?: AuthState;
};

export function getSharedAuthState(): AuthState {
  authGlobal.__nailAuthState ??= createAuthState();
  return authGlobal.__nailAuthState;
}

export async function hashOwnerPassword(
  password: string,
  options: { salt?: Buffer } = {},
): Promise<string> {
  if (password.length < 12 || password.length > 1024) {
    throw new Error("Owner password must be between 12 and 1024 characters");
  }
  const salt = options.salt ?? randomBytes(16);
  const derived = await derivePassword(password, salt);
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_BYTES, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

function isValidOwnerPasswordHash(encodedHash: string): boolean {
  const [algorithm, saltText, digestText, extra] = encodedHash.split(":");
  if (
    algorithm !== "scrypt" ||
    !saltText ||
    !digestText ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/.test(saltText) ||
    !/^[A-Za-z0-9_-]+$/.test(digestText)
  ) {
    return false;
  }
  return (
    Buffer.from(saltText, "base64url").length === 16 &&
    Buffer.from(digestText, "base64url").length === PASSWORD_BYTES
  );
}

async function verifyOwnerPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (!isValidOwnerPasswordHash(encodedHash) || password.length > 1024) {
    return false;
  }
  const [, saltText, digestText] = encodedHash.split(":");
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(digestText, "base64url");
  const actual = await derivePassword(password, salt);
  return timingSafeEqual(actual, expected);
}

function parseSecret(secret: string): Buffer | null {
  const key = Buffer.from(secret, "base64url");
  return key.length >= 32 ? key : null;
}

function signSession(payload: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function readSessionToken(
  token: string | undefined,
  secret: Buffer,
  nowSeconds: number,
): boolean {
  if (!token || token.length > 1024) return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;

  const expected = Buffer.from(signSession(payload, secret), "base64url");
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      exp?: unknown;
    };
    return decoded.sub === "owner" &&
      typeof decoded.exp === "number" &&
      Number.isSafeInteger(decoded.exp) &&
      decoded.exp > nowSeconds;
  } catch {
    return false;
  }
}

async function readJsonBody(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > 4096) {
    return null;
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
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
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function sameOrigin(request: Request, appOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const expected = new URL(appOrigin);
    return expected.origin === appOrigin && new URL(origin).origin === origin && origin === appOrigin;
  } catch {
    return false;
  }
}

export function isSameOriginRequest(request: Request, appOrigin: string): boolean {
  return sameOrigin(request, appOrigin);
}

function json(body: object, status: number, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
}

export function createAuthHandlers(
  config: AuthConfig,
  clock: Clock = Date.now,
  state: AuthState = createAuthState(),
) {
  const secret = parseSecret(config.sessionSecret);
  const originIsConfigured = (() => {
    try {
      const origin = new URL(config.appOrigin);
      return (
        origin.origin === config.appOrigin &&
        (!config.secureCookies || origin.protocol === "https:")
      );
    } catch {
      return false;
    }
  })();
  const sessionTtlSeconds = config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const failureLimit = config.loginFailureLimit ?? DEFAULT_FAILURE_LIMIT;
  const windowSeconds = config.loginWindowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const { failures, activeSessions } = state;

  function validConfig(): boolean {
    return Boolean(
      secret &&
        isValidOwnerPasswordHash(config.ownerPasswordHash) &&
        originIsConfigured &&
        Number.isSafeInteger(sessionTtlSeconds) &&
        sessionTtlSeconds > 0 &&
        Number.isSafeInteger(failureLimit) &&
        failureLimit > 0 &&
        Number.isSafeInteger(windowSeconds) &&
        windowSeconds > 0,
    );
  }

  function cookieHeader(value: string, maxAge: number): string {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookies ? "; Secure" : ""}`;
  }

  async function login(request: Request): Promise<Response> {
    if (!validConfig()) return json({ error: "Authentication is not configured" }, 503);
    if (!sameOrigin(request, config.appOrigin)) return json({ error: "Invalid origin" }, 403);
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
      return json({ error: "Unsupported content type" }, 415);
    }

    const body = await readJsonBody(request);
    if (body === null) return json({ error: "Invalid request" }, 400);

    const nowMs = clock();
    if (nowMs - failures.startedAt >= windowSeconds * 1000) {
      failures.count = 0;
      failures.startedAt = nowMs;
    }
    if (failures.count >= failureLimit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((failures.startedAt + windowSeconds * 1000 - nowMs) / 1000),
      );
      return json({ error: "Too many login attempts" }, 429, {
        "retry-after": String(retryAfter),
      });
    }

    const password =
      body && typeof body === "object" && "password" in body &&
      typeof body.password === "string"
        ? body.password
        : "";
    failures.count += 1;
    const validPassword = await verifyOwnerPassword(password, config.ownerPasswordHash);
    if (!validPassword) {
      return json({ error: "Invalid credentials" }, 401);
    }

    failures.count = 0;
    const expiresAt = Math.floor(nowMs / 1000) + sessionTtlSeconds;
    const payload = Buffer.from(
      JSON.stringify({ sub: "owner", exp: expiresAt }),
    ).toString("base64url");
    const token = `${payload}.${signSession(payload, secret!)}`;
    activeSessions.add(token);
    return json(
      { authenticated: true },
      200,
      { "set-cookie": cookieHeader(token, sessionTtlSeconds) },
    );
  }

  async function logout(request: Request): Promise<Response> {
    if (!validConfig()) return json({ error: "Authentication is not configured" }, 503);
    if (!sameOrigin(request, config.appOrigin)) return json({ error: "Invalid origin" }, 403);
    activeSessions.delete(readCookie(request, SESSION_COOKIE) ?? "");
    return json({ authenticated: false }, 200, {
      "set-cookie": cookieHeader("", 0),
    });
  }

  async function protectedResource(request: Request): Promise<Response> {
    if (!validConfig()) return json({ error: "Authentication is not configured" }, 503);
    const token = readCookie(request, SESSION_COOKIE);
    if (
      !token ||
      !activeSessions.has(token) ||
      !readSessionToken(token, secret!, Math.floor(clock() / 1000))
    ) {
      return json({ error: "Unauthorized" }, 401);
    }
    return json({ authenticated: true }, 200);
  }

  return { login, logout, protectedResource };
}

export function getAuthConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AuthConfig | null {
  const ownerPasswordHash = environment.OWNER_PASSWORD_HASH;
  const sessionSecret = environment.SESSION_SECRET;
  const appOrigin = environment.APP_ORIGIN;
  if (!ownerPasswordHash || !sessionSecret || !appOrigin) return null;

  return {
    ownerPasswordHash,
    sessionSecret,
    appOrigin,
    secureCookies: environment.NODE_ENV === "production",
  };
}
