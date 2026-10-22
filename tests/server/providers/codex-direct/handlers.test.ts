import { describe, expect, it, vi } from "vitest";
import { createCodexDirectHandlers } from "../../../../lib/server/providers/codex-direct/handlers";
import { CodexDirectError } from "../../../../lib/server/providers/codex-direct/types";

const origin = "https://nail.example";
const dto = { enabled: true, providerId: "provider-fixture", state: "connected" as const, model: null, revision: 2, inferenceReady: false as const };
function request(path: string, options: { method?: string; body?: unknown; origin?: string; contentType?: string; cookie?: string } = {}) {
  const headers = new Headers();
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.contentType !== undefined) headers.set("content-type", options.contentType);
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  const body = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  return new Request(`${origin}${path}`, { method: options.method ?? (body ? "POST" : "GET"), headers, body });
}
function fakeService() {
  return {
    account: vi.fn(async () => dto),
    start: vi.fn(async () => ({ providerId: dto.providerId, loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", verificationUri: "https://auth.openai.com/codex/device" as const, userCode: "ABCD-EFGH", intervalSeconds: 5, expiresAt: "2026-10-22T00:15:00.000Z" })),
    poll: vi.fn(async () => ({ state: "pending" as const, retryAfterSeconds: 5 })),
    cancel: vi.fn(async () => ({ cancelled: true as const })),
    disconnect: vi.fn(async () => ({ ...dto, state: "not_configured" as const, model: null })),
    refreshModels: vi.fn(async () => ({ models: [{ id: "fixture-model", label: "Fixture" }], checkedAt: "2026-10-22T00:00:00.000Z", account: dto })),
    selectModel: vi.fn(async () => dto),
  };
}
function setup(options: { authenticated?: boolean; enabled?: boolean; sessionHash?: string | null } = {}) {
  const service = fakeService();
  const createService = vi.fn(async () => ({ service, close: vi.fn(async () => undefined) }));
  const handlers = createCodexDirectHandlers({
    auth: { protectedResource: vi.fn(async () => options.authenticated === false ? Response.json({ error: "Unauthorized" }, { status: 401 }) : Response.json({ authenticated: true })) },
    getAppOrigin: () => origin,
    enabled: () => options.enabled ?? true,
    getSessionHash: vi.fn(() => options.sessionHash === undefined ? "a".repeat(64) : options.sessionHash),
    createService,
  });
  return { handlers, service, createService };
}

describe("owner-only direct Codex handlers", () => {
  it("authorizes before reading feature/runtime config or touching the service", async () => {
    const context = setup({ authenticated: false });
    const result = await context.handlers.start(request("/api/providers/codex-direct/login/start", { method: "POST", origin, contentType: "application/json", body: {} }));
    expect(result.status).toBe(401);
    expect(context.createService).not.toHaveBeenCalled();
  });

  it("requires exact origin and JSON before opening a service", async () => {
    const context = setup();
    const crossOrigin = await context.handlers.start(request("/api/providers/codex-direct/login/start", { method: "POST", origin: "https://evil.example", contentType: "application/json", body: {} }));
    expect(crossOrigin.status).toBe(403);
    const wrongType = await context.handlers.start(request("/api/providers/codex-direct/login/start", { method: "POST", origin, contentType: "text/plain", body: "{}" }));
    expect(wrongType.status).toBe(415);
    expect(context.createService).not.toHaveBeenCalled();
  });

  it("bounds streaming bodies and rejects malformed, invalid UTF-8, and extended fields", async () => {
    const context = setup();
    const tooLarge = await context.handlers.start(request("/api/providers/codex-direct/login/start", { method: "POST", origin, contentType: "application/json", body: `{"x":"${"x".repeat(16_400)}"}` }));
    expect(tooLarge.status).toBe(413);
    const extra = await context.handlers.start(request("/api/providers/codex-direct/login/start", { method: "POST", origin, contentType: "application/json", body: { clientId: "forged" } }));
    expect(extra.status).toBe(400);
    const invalidUtf8 = await context.handlers.start(new Request(`${origin}/api/providers/codex-direct/login/start`, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: new Uint8Array([0xff]),
    }));
    expect(invalidUtf8.status).toBe(400);
    expect(context.createService).not.toHaveBeenCalled();
  });

  it("returns device code only in a private no-store start response", async () => {
    const context = setup();
    const result = await context.handlers.start(request("/api/providers/codex-direct/login/start", { method: "POST", origin, contentType: "application/json", body: {}, cookie: "nail_session=signed-session" }));
    expect(result.status).toBe(201);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await result.json()).toMatchObject({ verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" });
    expect(context.service.start).toHaveBeenCalledWith("a".repeat(64), expect.any(AbortSignal));
  });

  it("returns a disabled account projection without database/network and blocks mutations", async () => {
    const context = setup({ enabled: false });
    const account = await context.handlers.account(request("/api/providers/codex-direct/account", { cookie: "nail_session=signed-session" }));
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({ enabled: false, state: "not_configured", providerId: null, inferenceReady: false });
    const disabled = await context.handlers.start(request("/api/providers/codex-direct/login/start", { method: "POST", origin, contentType: "application/json", body: {} }));
    expect(disabled.status).toBe(503);
    expect(context.createService).not.toHaveBeenCalled();
  });

  it("validates exact action schemas and maps expired/unknown login IDs to non-enumerating 404", async () => {
    const context = setup();
    const malformedPoll = await context.handlers.poll(request("/api/providers/codex-direct/login/poll", { method: "POST", origin, contentType: "application/json", body: { loginId: "bad", extra: true } }));
    expect(malformedPoll.status).toBe(400);
    context.service.poll.mockRejectedValueOnce(new CodexDirectError("login_expired"));
    const expired = await context.handlers.poll(request("/api/providers/codex-direct/login/poll", { method: "POST", origin, contentType: "application/json", body: { loginId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }));
    expect(expired.status).toBe(404);
    expect(context.createService).toHaveBeenCalledTimes(1);
  });

  it("requires a session cookie binding before a service operation", async () => {
    const context = setup({ sessionHash: null });
    const result = await context.handlers.start(request("/api/providers/codex-direct/login/start", { method: "POST", origin, contentType: "application/json", body: {} }));
    expect(result.status).toBe(401);
    expect(context.createService).not.toHaveBeenCalled();
  });
});
