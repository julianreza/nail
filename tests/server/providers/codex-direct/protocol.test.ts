import { describe, expect, it } from "vitest";
import { parseCodexModels, parseCodexTokens, parseDeviceGrant } from "../../../../lib/server/providers/codex-direct/protocol";
import { catalogFixture, NOW, tokensFixture } from "./fixtures";

describe("Codex direct protocol projections", () => {
  it("normalizes device grants and applies the bounded local expiry", () => {
    expect(parseDeviceGrant({ device_auth_id: "device_123", user_code: "ABCD-EFGH", interval: "2" }, NOW))
      .toEqual({ deviceAuthId: "device_123", userCode: "ABCD-EFGH", intervalSeconds: 5, expiresAt: NOW + 900_000 });
    expect(parseDeviceGrant({ device_auth_id: "device_123", usercode: "ABCD-EFGH", interval: 10, expires_in: 60 }, NOW))
      .toEqual({ deviceAuthId: "device_123", userCode: "ABCD-EFGH", intervalSeconds: 10, expiresAt: NOW + 60_000 });
  });

  it.each([
    null, [], {},
    { device_auth_id: "bad/id", user_code: "ABCD", interval: 5 },
    { device_auth_id: "device_123", user_code: "ABCD", interval: 0 },
    { device_auth_id: "device_123", user_code: "ABCD", interval: 61 },
    { device_auth_id: "device_123", user_code: "ABCD", interval: "NaN" },
    { device_auth_id: "device_123", user_code: "ABCD", interval: 5, expires_in: 0 },
    { device_auth_id: "device_123", user_code: "ABCD", interval: 5, expires_in: 901 },
  ])("rejects invalid device grant %# without echoing input", (value) => {
    expect(() => parseDeviceGrant(value, NOW)).toThrow();
    try { parseDeviceGrant(value, NOW); } catch (error) {
      expect((error as Error).message).not.toContain("device_123");
      expect((error as Error).message).not.toContain("ABCD");
    }
  });

  it("extracts only account routing metadata and bounds token lifetime", () => {
    expect(parseCodexTokens(tokensFixture(), NOW)).toEqual({
      accessToken: tokensFixture().access_token,
      refreshToken: "fixture_refresh_do_not_log",
      expiresAt: NOW + 3_600_000,
      accountId: "fixture_account",
    });
  });

  it.each([
    null,
    { access_token: "not.jwt", refresh_token: "refresh", expires_in: 60 },
    { access_token: "a.!.b", refresh_token: "refresh", expires_in: 60 },
    { access_token: "a.e30.b", refresh_token: "refresh", expires_in: 60 },
    { access_token: "a.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiLi4vIn19.b", refresh_token: "refresh", expires_in: 60 },
    { access_token: "a.e30.b", refresh_token: "", expires_in: 60 },
    { access_token: "a.e30.b", refresh_token: "x".repeat(16_385), expires_in: 60 },
    { access_token: "a.e30.b", refresh_token: "refresh", expires_in: 0 },
    { access_token: "a.e30.b", refresh_token: "refresh", expires_in: 31 * 24 * 60 * 60 + 1 },
  ])("rejects malformed tokens without leaking token text %#", (value) => {
    expect(() => parseCodexTokens(value, NOW)).toThrow();
    try { parseCodexTokens(value, NOW); } catch (error) {
      expect((error as Error).message).not.toContain("refresh");
      expect((error as Error).message).not.toContain("../");
    }
  });

  it("projects only visible models, without vendor instructions", () => {
    const raw = { models: [
      ...catalogFixture().models,
      { slug: "none-model", display_name: "None", visibility: "none", priority: 2, instructions: "do not expose" },
    ] };
    expect(parseCodexModels(raw)).toEqual([{ id: "fixture-model", label: "Fixture model" }]);
    expect(JSON.stringify(parseCodexModels(raw))).not.toContain("do not expose");
  });

  it("accepts only the documented models wrapper", () => {
    expect(() => parseCodexModels({ data: [{ id: "fixture-model" }] })).toThrow();
    expect(parseCodexModels({ models: [] })).toEqual([]);
  });

  it.each([
    { models: [null] },
    { models: [{ slug: "unsafe/id", display_name: "bad", visibility: "list", priority: 1 }] },
    { models: [{ slug: "ok", display_name: "bad\u0000label", visibility: "list", priority: 1 }] },
    { models: [{ slug: "ok", display_name: "label", visibility: "new", priority: 1 }] },
    { models: [{ slug: "ok", display_name: "label", visibility: "list", priority: 1.5 }] },
    { models: [
      { slug: "same", display_name: "one", visibility: "list", priority: 1 },
      { slug: "same", display_name: "two", visibility: "hide", priority: 2 },
    ] },
  ])("rejects malformed catalog entries %#", (value) => {
    expect(() => parseCodexModels(value)).toThrow();
  });

  it("orders visible models by priority and stable slug", () => {
    expect(parseCodexModels({ models: [
      { slug: "z-model", display_name: "Z", visibility: "list", priority: 1 },
      { slug: "b-model", display_name: "B", visibility: "list", priority: 2 },
      { slug: "a-model", display_name: "A", visibility: "list", priority: 2 },
    ] })).toEqual([
      { id: "z-model", label: "Z" },
      { id: "a-model", label: "A" },
      { id: "b-model", label: "B" },
    ]);
  });
});
