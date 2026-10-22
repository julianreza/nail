import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openCodexSecret, sealCodexSecret } from "../../../../lib/server/providers/codex-direct/crypto";

const key = () => randomBytes(32);
const aad = "codex-direct-account:provider-fixture:1";
const secretFixture = {
  accessToken: "access_fixture_secret",
  refreshToken: "refresh_fixture_secret",
  accountId: "account_fixture_secret",
  code: "one_time_code_fixture",
};

describe("Codex direct encrypted envelopes", () => {
  it("round trips JSON under purpose-bound AES-GCM encryption", () => {
    const encryptionKey = key();
    const envelope = sealCodexSecret(secretFixture, encryptionKey, aad);
    expect(envelope).not.toContain(secretFixture.accessToken);
    expect(envelope).not.toContain(secretFixture.refreshToken);
    expect(envelope).not.toContain(secretFixture.accountId);
    expect(envelope).not.toContain(secretFixture.code);
    expect(openCodexSecret<typeof secretFixture>(envelope, encryptionKey, aad)).toEqual(secretFixture);
  });

  it("uses a unique IV for every encryption of the same value", () => {
    const encryptionKey = key();
    expect(sealCodexSecret(secretFixture, encryptionKey, aad)).not.toBe(sealCodexSecret(secretFixture, encryptionKey, aad));
  });

  it("rejects tampered ciphertext, tag, or mismatched row-purpose-generation AAD", () => {
    const encryptionKey = key();
    const envelope = JSON.parse(sealCodexSecret(secretFixture, encryptionKey, aad)) as { version: number; iv: string; tag: string; ciphertext: string };
    const tamperedCiphertext = { ...envelope, ciphertext: Buffer.from("tampered").toString("base64url") };
    const tamperedTag = { ...envelope, tag: Buffer.alloc(16, 1).toString("base64url") };
    for (const candidate of [tamperedCiphertext, tamperedTag]) {
      expect(() => openCodexSecret(JSON.stringify(candidate), encryptionKey, aad)).toThrow("Encrypted value is invalid");
    }
    expect(() => openCodexSecret(JSON.stringify(envelope), encryptionKey, "codex-direct-login:provider-fixture:1"))
      .toThrow("Encrypted value is invalid");
    expect(() => openCodexSecret(JSON.stringify(envelope), encryptionKey, "codex-direct-account:provider-fixture:2"))
      .toThrow("Encrypted value is invalid");
  });

  it("rejects malformed, oversized, or unsupported envelopes without secret text", () => {
    const encryptionKey = key();
    for (const envelope of ["not-json", "{}", `{"version":2,"iv":"${"A".repeat(32)}"}`, "x".repeat(96 * 1024 + 1)]) {
      expect(() => openCodexSecret(envelope, encryptionKey, aad)).toThrow("Encrypted value is invalid");
      expect(envelope).not.toContain(secretFixture.refreshToken);
    }
  });

  it("requires a 32-byte key, bounded JSON plaintext, and bounded AAD", () => {
    expect(() => sealCodexSecret(secretFixture, randomBytes(31), aad)).toThrow("Encrypted value is invalid");
    expect(() => sealCodexSecret(secretFixture, randomBytes(33), aad)).toThrow("Encrypted value is invalid");
    expect(() => openCodexSecret("{}", randomBytes(31), aad)).toThrow("Encrypted value is invalid");
    expect(() => sealCodexSecret("x".repeat(64 * 1024 + 1), key(), aad)).toThrow("Encrypted value is invalid");
    expect(() => sealCodexSecret(secretFixture, key(), "x".repeat(2049))).toThrow("Encrypted value is invalid");
  });
});
