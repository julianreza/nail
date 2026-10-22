import type { CodexModel, CodexTokens, DeviceGrant } from "./types";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,200}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const USER_CODE = /^[A-Za-z0-9-]{4,32}$/;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_MODELS = 500;
const MAX_DEVICE_LIFETIME_SECONDS = 15 * 60;
const MAX_TOKEN_LIFETIME_SECONDS = 31 * 24 * 60 * 60;
const INVALID_RESPONSE = "Codex response is invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw new Error(INVALID_RESPONSE);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!isRecord(parsed)) throw new Error(INVALID_RESPONSE);
    return parsed;
  } catch {
    throw new Error(INVALID_RESPONSE);
  }
}

export function parseDeviceGrant(value: unknown, now: number): DeviceGrant {
  if (!isRecord(value) || !Number.isSafeInteger(now) || now < 0) throw new Error(INVALID_RESPONSE);
  const deviceAuthId = value.device_auth_id;
  const userCode = value.user_code ?? value.usercode;
  const interval = parsePositiveInteger(value.interval);
  const vendorExpiry = value.expires_in === undefined ? MAX_DEVICE_LIFETIME_SECONDS : parsePositiveInteger(value.expires_in);
  if (
    typeof deviceAuthId !== "string" || !DEVICE_ID.test(deviceAuthId) ||
    typeof userCode !== "string" || !USER_CODE.test(userCode) ||
    interval === null || interval > 60 || vendorExpiry === null || vendorExpiry > MAX_DEVICE_LIFETIME_SECONDS
  ) throw new Error(INVALID_RESPONSE);
  return {
    deviceAuthId,
    userCode,
    intervalSeconds: Math.max(5, interval),
    expiresAt: now + vendorExpiry * 1000,
  };
}

export function parseCodexTokens(value: unknown, now: number): CodexTokens {
  if (!isRecord(value) || !Number.isSafeInteger(now) || now < 0) throw new Error(INVALID_RESPONSE);
  const accessToken = value.access_token;
  const refreshToken = value.refresh_token;
  const lifetime = parsePositiveInteger(value.expires_in);
  if (
    typeof accessToken !== "string" || Buffer.byteLength(accessToken) > MAX_TOKEN_BYTES ||
    typeof refreshToken !== "string" || refreshToken.length === 0 || Buffer.byteLength(refreshToken) > MAX_TOKEN_BYTES ||
    lifetime === null || lifetime > MAX_TOKEN_LIFETIME_SECONDS
  ) throw new Error(INVALID_RESPONSE);
  const claims = decodeJwtPayload(accessToken);
  const auth = claims["https://api.openai.com/auth"];
  if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string" || !ACCOUNT_ID.test(auth.chatgpt_account_id)) {
    throw new Error(INVALID_RESPONSE);
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: now + lifetime * 1000,
    accountId: auth.chatgpt_account_id,
  };
}

export function parseCodexModels(value: unknown): CodexModel[] {
  if (!isRecord(value) || !Array.isArray(value.models) || value.models.length > MAX_MODELS) {
    throw new Error(INVALID_RESPONSE);
  }
  const ids = new Set<string>();
  const visible: Array<CodexModel & { priority: number }> = [];
  for (const candidate of value.models) {
    if (!isRecord(candidate)) throw new Error(INVALID_RESPONSE);
    const { slug, display_name: displayName, visibility, priority } = candidate;
    if (
      typeof slug !== "string" || !MODEL_ID.test(slug) || ids.has(slug) ||
      typeof displayName !== "string" || displayName.length < 1 || displayName.length > 120 || /[\u0000-\u001f\u007f]/.test(displayName) ||
      !["list", "hide", "none"].includes(String(visibility)) ||
      typeof priority !== "number" || !Number.isSafeInteger(priority)
    ) throw new Error(INVALID_RESPONSE);
    ids.add(slug);
    if (visibility === "list") visible.push({ id: slug, label: displayName, priority });
  }
  return visible.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map(({ id, label }) => ({ id, label }));
}
