import { describe, expect, it } from "vitest";
import {
  createAuthHandlers,
  createAuthState,
  getOwnerSessionBindingHash,
  hashOwnerPassword,
  type AuthConfig,
} from "../../../lib/server/auth/auth-service";

const now = 1_800_000_000_000;

async function createTestHandlers(overrides: Partial<AuthConfig> = {}) {
  const ownerPasswordHash = await hashOwnerPassword("correct horse battery", {
    salt: Buffer.alloc(16, 7),
  });
  return createAuthHandlers(
    {
      ownerPasswordHash,
      sessionSecret: Buffer.alloc(32, 9).toString("base64url"),
      appOrigin: "https://nail.example",
      secureCookies: true,
      sessionTtlSeconds: 60,
      ...overrides,
    },
    () => now,
  );
}

function loginRequest(
  password: string,
  origin = "https://nail.example",
): Request {
  return new Request("https://nail.example/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ password }),
  });
}

describe("owner authentication", () => {
  it("shares active sessions across route handler instances", async () => {
    const config: AuthConfig = {
      ownerPasswordHash: await hashOwnerPassword("correct horse battery", {
        salt: Buffer.alloc(16, 7),
      }),
      sessionSecret: Buffer.alloc(32, 9).toString("base64url"),
      appOrigin: "https://nail.example",
      secureCookies: true,
      sessionTtlSeconds: 60,
    };
    const state = createAuthState();
    const loginHandlers = createAuthHandlers(config, () => now, state);
    const pageHandlers = createAuthHandlers(config, () => now, state);
    const response = await loginHandlers.login(loginRequest("correct horse battery"));
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";

    expect(
      (await pageHandlers.protectedResource(
        new Request("https://nail.example/", { headers: { cookie } }),
      )).status,
    ).toBe(200);
  });

  it("binds private state to an HMAC of the Nail session cookie without returning it", () => {
    const secret = Buffer.alloc(32, 19).toString("base64url");
    const cookieValue = "signed.owner.session.fixture";
    const request = (cookie: string) => new Request("https://nail.example/private", { headers: { cookie: `nail_session=${cookie}` } });
    const hash = getOwnerSessionBindingHash(request(cookieValue), secret);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(cookieValue);
    expect(getOwnerSessionBindingHash(request(cookieValue), secret)).toBe(hash);
    expect(getOwnerSessionBindingHash(request("different.session.fixture"), secret)).not.toBe(hash);
    expect(getOwnerSessionBindingHash(new Request("https://nail.example/private"), secret)).toBeNull();
    expect(getOwnerSessionBindingHash(request(cookieValue), "invalid-secret")).toBeNull();
  });

  it("sets a protected, expiring session cookie for valid owner credentials", async () => {
    const handlers = await createTestHandlers();
    const response = await handlers.login(loginRequest("correct horse battery"));

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=60");
    expect(await response.json()).toEqual({ authenticated: true });
  });

  it("fails closed when HTTPS cookies are configured with an HTTP origin", async () => {
    const handlers = await createTestHandlers({ appOrigin: "http://nail.example" });
    expect(
      (await handlers.login(loginRequest("correct horse battery", "http://nail.example"))).status,
    ).toBe(503);
  });

  it("rejects invalid credentials without disclosing which check failed", async () => {
    const handlers = await createTestHandlers();
    const response = await handlers.login(loginRequest("wrong password"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid credentials" });
    expect(response.headers.has("set-cookie")).toBe(false);
  });

  it("rejects missing or cross-origin Origin headers for mutations", async () => {
    const handlers = await createTestHandlers();
    const crossOrigin = await handlers.login(loginRequest("correct horse battery", "https://evil.example"));
    const missingOrigin = await handlers.login(
      new Request("https://nail.example/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "correct horse battery" }),
      }),
    );

    expect(crossOrigin.status).toBe(403);
    expect(missingOrigin.status).toBe(403);
  });

  it("rejects oversized JSON bodies even when Content-Length is absent", async () => {
    const handlers = await createTestHandlers();
    const response = await handlers.login(
      new Request("https://nail.example/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://nail.example",
        },
        body: JSON.stringify({ password: "x".repeat(5000) }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rate limits failed logins and allows retry after the window", async () => {
    const handlers = await createTestHandlers({ loginFailureLimit: 2, loginWindowSeconds: 30 });

    expect((await handlers.login(loginRequest("wrong one"))).status).toBe(401);
    expect((await handlers.login(loginRequest("wrong two"))).status).toBe(401);
    const limited = await handlers.login(loginRequest("correct horse battery"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");

    const laterHandlers = createAuthHandlers(
      {
        ownerPasswordHash: await hashOwnerPassword("correct horse battery", {
          salt: Buffer.alloc(16, 7),
        }),
        sessionSecret: Buffer.alloc(32, 9).toString("base64url"),
        appOrigin: "https://nail.example",
        secureCookies: true,
        sessionTtlSeconds: 60,
        loginFailureLimit: 2,
        loginWindowSeconds: 30,
      },
      () => now + 31_000,
    );
    expect((await laterHandlers.login(loginRequest("correct horse battery"))).status).toBe(200);
  });

  it("enforces the login limit across concurrent requests", async () => {
    const handlers = await createTestHandlers({ loginFailureLimit: 2, loginWindowSeconds: 30 });
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        handlers.login(loginRequest(`wrong password ${index}`)),
      ),
    );

    expect(responses.filter((response) => response.status === 401)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(4);
  });

  it("rejects expired, modified, and absent sessions on protected resources", async () => {
    const handlers = await createTestHandlers({ sessionTtlSeconds: 1 });
    const loginResponse = await handlers.login(loginRequest("correct horse battery"));
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
    const protectedRequest = (value: string) =>
      new Request("https://nail.example/api/private", {
        headers: { cookie: value },
      });

    expect((await handlers.protectedResource(protectedRequest(cookie))).status).toBe(200);
    expect((await handlers.protectedResource(protectedRequest(""))).status).toBe(401);
    expect(
      (await handlers.protectedResource(protectedRequest(`${cookie}tampered`))).status,
    ).toBe(401);

    const expiredHandlers = createAuthHandlers(
      {
        ownerPasswordHash: await hashOwnerPassword("correct horse battery", {
          salt: Buffer.alloc(16, 7),
        }),
        sessionSecret: Buffer.alloc(32, 9).toString("base64url"),
        appOrigin: "https://nail.example",
        secureCookies: true,
        sessionTtlSeconds: 1,
      },
      () => now + 2_000,
    );
    expect(
      (
        await expiredHandlers.protectedResource(
          protectedRequest(cookie),
        )
      ).status,
    ).toBe(401);
  });

  it("requires owner authentication for API and event-stream access", async () => {
    const handlers = await createTestHandlers();
    const request = new Request("https://nail.example/api/events");

    expect((await handlers.protectedResource(request)).status).toBe(401);
  });

  it("clears the session cookie only for same-origin logout and revokes it", async () => {
    const handlers = await createTestHandlers();
    const loginResponse = await handlers.login(loginRequest("correct horse battery"));
    const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
    const response = await handlers.logout(
      new Request("https://nail.example/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://nail.example", cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      (await handlers.protectedResource(new Request("https://nail.example/api/private", { headers: { cookie } }))).status,
    ).toBe(401);
    expect(
      (
        await handlers.logout(
          new Request("https://nail.example/api/auth/logout", {
            method: "POST",
            headers: { origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(403);
  });
});
