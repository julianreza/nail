import { describe, expect, it, vi } from "vitest";
import { requestCodexJson } from "../../../../lib/server/providers/codex-direct/http";
import { CodexDirectError } from "../../../../lib/server/providers/codex-direct/types";

const config = {
  clientId: "reviewed-client-id",
  clientVersion: "1.2.3",
  tokens: {
    accessToken: "access-fixture",
    refreshToken: "refresh-fixture",
    expiresAt: 1,
    accountId: "account_fixture",
  },
};
const signal = () => new AbortController().signal;
const deps = (fetcher: typeof fetch, abortSignal = signal(), overrides: Partial<typeof config> = {}) => ({ ...config, ...overrides, fetcher, signal: abortSignal });

function response(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("bounded Codex direct HTTP requests", () => {
  it("builds fixed start and poll requests without browser credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('{"device_auth_id":"device_123"}'));
    const start = await requestCodexJson("start", {}, deps(fetcher));
    expect(start).toEqual({ status: 200, value: { device_auth_id: "device_123" } });
    const [startUrl, startInit] = fetcher.mock.calls[0];
    expect(startUrl).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(startInit).toMatchObject({
      method: "POST", redirect: "error", credentials: "omit",
      body: JSON.stringify({ client_id: config.clientId }),
    });
    const startHeaders = new Headers(startInit?.headers);
    expect(startHeaders.get("content-type")).toBe("application/json");
    expect(startHeaders.has("authorization")).toBe(false);

    fetcher.mockResolvedValueOnce(response('{"error":"pending"}', 403));
    const poll = await requestCodexJson("poll", { deviceAuthId: "device_123", userCode: "ABCD-EFGH" }, deps(fetcher));
    expect(poll).toMatchObject({ status: 403 });
    const [pollUrl, pollInit] = fetcher.mock.calls[1];
    expect(pollUrl).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
    expect(JSON.parse(String(pollInit?.body))).toEqual({ device_auth_id: "device_123", user_code: "ABCD-EFGH" });
    expect(pollInit).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(new Headers(pollInit?.headers).has("authorization")).toBe(false);
  });

  it("builds token exchange/refresh as exact form posts and models with account auth", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response("{}"));
    await requestCodexJson("exchange", { code: "code_fixture", codeVerifier: "verify_fixture" }, deps(fetcher));
    const [, exchange] = fetcher.mock.calls[0];
    expect(exchange?.method).toBe("POST");
    expect(exchange?.body).toBe(new URLSearchParams({
      grant_type: "authorization_code", client_id: config.clientId, code: "code_fixture",
      code_verifier: "verify_fixture", redirect_uri: "https://auth.openai.com/deviceauth/callback",
    }).toString());

    await requestCodexJson("refresh", { refreshToken: config.tokens.refreshToken }, deps(fetcher));
    const [, refresh] = fetcher.mock.calls[1];
    expect(refresh?.body).toBe(new URLSearchParams({
      grant_type: "refresh_token", client_id: config.clientId, refresh_token: config.tokens.refreshToken,
    }).toString());

    await requestCodexJson("models", {}, deps(fetcher));
    const [modelsUrl, models] = fetcher.mock.calls[2];
    expect(modelsUrl).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.2.3");
    expect(models?.method).toBe("GET");
    const modelHeaders = new Headers(models?.headers);
    expect(modelHeaders.get("authorization")).toBe("Bearer access-fixture");
    expect(modelHeaders.get("chatgpt-account-id")).toBe("account_fixture");
    expect(modelHeaders.get("originator")).toBe("nail");
    expect(models?.credentials).toBe("omit");
  });

  it("rejects payloads that try to change URLs, headers, or operation fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response("{}"));
    await expect(requestCodexJson("start", { url: "https://attacker.invalid/", clientId: "other" }, deps(fetcher)))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(requestCodexJson("poll", { deviceAuthId: "device_123", userCode: "ABCD", authorization: "Bearer injected" }, deps(fetcher)))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(requestCodexJson("models", { url: "https://attacker.invalid/" }, deps(fetcher)))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid client", { clientId: " client" }, "invalid_request"],
    ["invalid version", { clientVersion: "latest" }, "invalid_request"],
  ] as const)("rejects %s before fetching", async (_label, override, code) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(requestCodexJson("start", {}, deps(fetcher, signal(), override))).rejects.toMatchObject({ code });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects redirects, classifies rate limits/server failures, and never leaks body text", async () => {
    const secret = "refresh_secret_fixture";
    const redirectFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(secret, { status: 302 }));
    await expect(requestCodexJson("start", {}, deps(redirectFetcher))).rejects.toMatchObject({ code: "unsupported_protocol" });
    const limitedFetcher = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({ error: secret }), 429));
    await expect(requestCodexJson("models", {}, deps(limitedFetcher))).rejects.toMatchObject({ code: "rate_limited" });
    const failedFetcher = vi.fn<typeof fetch>().mockResolvedValue(response(JSON.stringify({ error: secret }), 503));
    await expect(requestCodexJson("models", {}, deps(failedFetcher))).rejects.toMatchObject({ code: "unavailable" });
    for (const failure of [
      await requestCodexJson("poll", { deviceAuthId: "device_123", userCode: "ABCD" }, deps(vi.fn<typeof fetch>().mockResolvedValue(response(secret, 403)))),
    ]) expect(JSON.stringify(failure)).not.toContain(secret);
    try { await requestCodexJson("models", {}, deps(failedFetcher)); } catch (error) {
      expect(error).toBeInstanceOf(CodexDirectError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("caps streamed body bytes before parsing, including split chunks", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000).fill(65));
        controller.enqueue(new Uint8Array(500_000).fill(66));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(requestCodexJson("models", {}, deps(fetcher))).rejects.toMatchObject({ code: "output_limit" });
  });

  it("rejects invalid UTF-8 and malformed JSON with fixed safe errors", async () => {
    for (const body of [new Uint8Array([0xff]), "not-json"]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
      await expect(requestCodexJson("models", {}, deps(fetcher))).rejects.toMatchObject({ code: "unsupported_protocol" });
      try { await requestCodexJson("models", {}, deps(fetcher)); } catch (error) {
        expect((error as Error).message).not.toContain("not-json");
      }
    }
  });

  it("rejects an already-aborted request without calling fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(requestCodexJson("start", {}, deps(fetcher, controller.signal))).rejects.toMatchObject({ code: "cancelled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels a stalled body when the caller aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start() {},
      cancel() { cancelled = true; },
    }), { status: 200 }));
    const pending = requestCodexJson("models", {}, deps(fetcher, controller.signal));
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelled).toBe(true);
  });
});
