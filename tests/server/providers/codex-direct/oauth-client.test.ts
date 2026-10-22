import { describe, expect, it, vi } from "vitest";
import { createCodexOAuthClient } from "../../../../lib/server/providers/codex-direct/oauth-client";
import { catalogFixture, NOW, tokensFixture } from "./fixtures";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function client(fetcher: typeof fetch) {
  return createCodexOAuthClient({ clientId: "reviewed-client-id", clientVersion: "1.2.3", fetcher, clock: () => NOW });
}

describe("Codex device OAuth client", () => {
  it("starts, polls pending, exchanges, refreshes, then discovers visible models", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ device_auth_id: "device_123", user_code: "ABCD-EFGH", interval: "5" }))
      .mockResolvedValueOnce(json({ error: "deviceauth_authorization_pending" }, 403))
      .mockResolvedValueOnce(json({ authorization_code: "auth_code", code_verifier: "pkce_verifier" }))
      .mockResolvedValueOnce(json(tokensFixture()))
      .mockResolvedValueOnce(json(tokensFixture()))
      .mockResolvedValueOnce(json(catalogFixture()));
    const oauth = client(fetcher);
    const grant = await oauth.start(new AbortController().signal);
    expect(grant).toEqual({ deviceAuthId: "device_123", userCode: "ABCD-EFGH", intervalSeconds: 5, expiresAt: NOW + 900_000 });
    expect(await oauth.poll(grant, new AbortController().signal)).toEqual({ state: "pending", slowDown: false });
    const code = await oauth.poll(grant, new AbortController().signal);
    expect(code).toEqual({ state: "code", code: "auth_code", verifier: "pkce_verifier" });
    const tokens = await oauth.exchange(code.code, code.verifier, new AbortController().signal);
    expect(tokens).toMatchObject({ accountId: "fixture_account", refreshToken: "fixture_refresh_do_not_log", expiresAt: NOW + 3_600_000 });
    expect(await oauth.refresh(tokens, new AbortController().signal)).toEqual(tokens);
    expect(await oauth.models(tokens, new AbortController().signal)).toEqual([{ id: "fixture-model", label: "Fixture model" }]);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls[0][0]).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(fetcher.mock.calls[2][0]).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
    expect(fetcher.mock.calls[3][0]).toBe("https://auth.openai.com/oauth/token");
    expect(fetcher.mock.calls[4][0]).toBe("https://auth.openai.com/oauth/token");
    expect(String(fetcher.mock.calls[3][1]?.body)).toContain("grant_type=authorization_code");
    expect(String(fetcher.mock.calls[4][1]?.body)).toContain("grant_type=refresh_token");
  });

  it("increases polling delay on a recognized slowdown and keeps waiting only for poll responses", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ device_auth_id: "device_123", user_code: "ABCD-EFGH", interval: 5 }))
      .mockResolvedValueOnce(json({ error: "slow_down" }, 400));
    const oauth = client(fetcher);
    const grant = await oauth.start(new AbortController().signal);
    expect(await oauth.poll(grant, new AbortController().signal)).toEqual({ state: "pending", slowDown: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("maps invalid_grant to needs_login and never retries refresh", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "invalid_grant" }, 400));
    const oauth = client(fetcher);
    await expect(oauth.refresh({
      accessToken: tokensFixture().access_token,
      refreshToken: "refresh-fixture",
      expiresAt: NOW,
      accountId: "fixture_account",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "needs_login" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a rotated token whose account identity changed", async () => {
    const newTokens = tokensFixture();
    const other = { "https://api.openai.com/auth": { chatgpt_account_id: "other_account" } };
    newTokens.access_token = `fixture.${Buffer.from(JSON.stringify(other)).toString("base64url")}.signature`;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(newTokens));
    const oauth = client(fetcher);
    await expect(oauth.refresh({
      accessToken: tokensFixture().access_token,
      refreshToken: "refresh-fixture",
      expiresAt: NOW,
      accountId: "fixture_account",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_protocol" });
  });

  it("rejects malformed grants and response bodies with fixed errors", async () => {
    const invalidStart = client(vi.fn<typeof fetch>().mockResolvedValue(json({ device_auth_id: "../secret", user_code: "ABCD", interval: 5 })));
    await expect(invalidStart.start(new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_protocol" });
    const invalidPoll = client(vi.fn<typeof fetch>().mockResolvedValue(json({ authorization_code: "", code_verifier: "" })));
    const grant = { deviceAuthId: "device_123", userCode: "ABCD", intervalSeconds: 5, expiresAt: NOW + 60_000 };
    await expect(invalidPoll.poll(grant, new AbortController().signal)).rejects.toMatchObject({ code: "unsupported_protocol" });
  });
});
