import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 96 * 1024;
const MAX_AAD_BYTES = 2048;
const INVALID_ENCRYPTED_VALUE = "Encrypted value is invalid";

interface EncryptedEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

function invalid(): never {
  throw new Error(INVALID_ENCRYPTED_VALUE);
}

function validateInputs(key: Buffer, aad: string): void {
  if (!Buffer.isBuffer(key) || key.byteLength !== KEY_BYTES || typeof aad !== "string" || !aad || Buffer.byteLength(aad) > MAX_AAD_BYTES) {
    return invalid();
  }
}

function decodeBase64Url(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)) return invalid();
  return decoded;
}

export function sealCodexSecret(value: unknown, key: Buffer, aad: string): string {
  validateInputs(key, aad);
  let plaintext: string;
  try {
    plaintext = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (typeof plaintext !== "string" || Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) return invalid();

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    const encoded = JSON.stringify(envelope);
    if (Buffer.byteLength(encoded) > MAX_ENVELOPE_BYTES) return invalid();
    return encoded;
  } catch {
    return invalid();
  }
}

export function openCodexSecret<T>(envelope: string, key: Buffer, aad: string): T {
  validateInputs(key, aad);
  if (typeof envelope !== "string" || Buffer.byteLength(envelope) > MAX_ENVELOPE_BYTES) return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid();
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "ciphertext,iv,tag,version" || record.version !== 1) return invalid();
  const iv = decodeBase64Url(record.iv, IV_BYTES);
  const tag = decodeBase64Url(record.tag, TAG_BYTES);
  const ciphertext = decodeBase64Url(record.ciphertext);
  if (ciphertext.byteLength > MAX_PLAINTEXT_BYTES) return invalid();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES) return invalid();
    return JSON.parse(plaintext) as T;
  } catch {
    return invalid();
  }
}
