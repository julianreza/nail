import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const SECRET_REFERENCE_PREFIX = "secret:";
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const SECRET_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const MAX_SECRET_BYTES = 16 * 1024;

interface EncryptedSecretRecord {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedSecretStore {
  private readonly directory: string;
  private readonly key: Buffer;

  constructor(directory: string, encryptionKey: Buffer) {
    if (!isAbsolute(directory)) throw new Error("Secret directory must be an absolute path");
    if (encryptionKey.byteLength !== 32) {
      throw new Error("Secret encryption key must be exactly 32 bytes");
    }
    this.directory = resolve(directory);
    this.key = Buffer.from(encryptionKey);
  }

  put(secret: string): string {
    if (typeof secret !== "string" || secret.length === 0 || Buffer.byteLength(secret) > MAX_SECRET_BYTES) {
      throw new Error("Secret value is invalid");
    }
    this.ensurePrivateDirectory();

    const id = randomUUID();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(id, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    const record: EncryptedSecretRecord = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };

    const destination = this.filePath(id);
    const temporary = this.filePath(`${id}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(record), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, destination);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return `${SECRET_REFERENCE_PREFIX}${id}`;
  }

  get(reference: string): string {
    const id = this.idFromReference(reference);
    this.assertPrivateDirectory();
    const path = this.filePath(id);
    const stat = statSync(path);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("Encrypted secret file permissions must be owner-only");
    }

    let record: EncryptedSecretRecord;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as EncryptedSecretRecord;
    } catch {
      throw new Error("Encrypted secret record is invalid");
    }
    if (
      record.version !== 1 ||
      !record.iv ||
      !record.tag ||
      !record.ciphertext
    ) {
      throw new Error("Encrypted secret record is invalid");
    }

    try {
      const decipher = createDecipheriv(
        ENCRYPTION_ALGORITHM,
        this.key,
        Buffer.from(record.iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(id, "utf8"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Encrypted secret could not be authenticated");
    }
  }

  delete(reference: string): void {
    const id = this.idFromReference(reference);
    this.assertPrivateDirectory();
    rmSync(this.filePath(id), { force: true });
  }

  private ensurePrivateDirectory(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const mode = statSync(this.directory).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error("Secret directory must not be accessible by group or other users");
    }
  }

  private assertPrivateDirectory(): void {
    const mode = statSync(this.directory).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error("Secret directory must not be accessible by group or other users");
    }
  }

  private idFromReference(reference: string): string {
    const id = reference.startsWith(SECRET_REFERENCE_PREFIX)
      ? reference.slice(SECRET_REFERENCE_PREFIX.length)
      : "";
    if (!SECRET_ID_PATTERN.test(id)) throw new Error("Secret reference is invalid");
    return id;
  }

  private filePath(id: string): string {
    return join(this.directory, `${id}.json`);
  }
}

export function createSecretStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): EncryptedSecretStore {
  const directory = environment.NAIL_SECRET_DIR;
  const encodedKey = environment.NAIL_SECRET_ENCRYPTION_KEY;
  if (!directory || !encodedKey) {
    throw new Error("Secret storage is not configured");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encodedKey)) {
    throw new Error("Secret encryption key encoding is invalid");
  }
  const key = Buffer.from(encodedKey, "base64url");
  return new EncryptedSecretStore(directory, key);
}
