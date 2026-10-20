import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createRepositories, type ProviderRecord } from "../db/repositories";
import { withTransaction } from "../db/database";
import { EncryptedSecretStore } from "./secret-store";

const MODELS_URL = "https://api.deepseek.com/models";
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_API_KEY_BYTES = 16 * 1024;

export type ProviderSetupErrorCode =
  | "invalid_input"
  | "duplicate_provider"
  | "invalid_credentials"
  | "provider_unavailable"
  | "model_not_available";

export class ProviderSetupError extends Error {
  constructor(
    public readonly code: ProviderSetupErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ProviderSetupError";
  }
}

export interface DeepSeekProviderSetupInput {
  apiKey: string;
  model: string;
}

export type SafeProviderRecord = Omit<ProviderRecord, "secretReference">;

function validateInput(input: DeepSeekProviderSetupInput): void {
  if (
    typeof input.apiKey !== "string" ||
    input.apiKey.trim().length === 0 ||
    Buffer.byteLength(input.apiKey, "utf8") > MAX_API_KEY_BYTES ||
    input.apiKey !== input.apiKey.trim() ||
    typeof input.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.model)
  ) {
    throw new ProviderSetupError("invalid_input", "Provider details are invalid", 400);
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("Provider response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Provider response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

async function assertCredentialAndModel(
  apiKey: string,
  model: string,
  fetcher: typeof fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(MODELS_URL, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
  } catch {
    throw new ProviderSetupError("provider_unavailable", "DeepSeek could not be reached", 502);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderSetupError("invalid_credentials", "DeepSeek rejected this API key", 401);
  }
  if (!response.ok) {
    throw new ProviderSetupError("provider_unavailable", "DeepSeek could not validate the API key", 502);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedResponse(response));
  } catch {
    throw new ProviderSetupError("provider_unavailable", "DeepSeek returned an invalid response", 502);
  }
  if (
    typeof parsed !== "object" || parsed === null || !("data" in parsed) ||
    !Array.isArray(parsed.data) || parsed.data.length > 512
  ) {
    throw new ProviderSetupError("provider_unavailable", "DeepSeek returned an invalid response", 502);
  }
  const availableModels = parsed.data.flatMap((item) =>
    typeof item === "object" && item !== null && "id" in item &&
    typeof item.id === "string" && item.id.length <= 128
      ? [item.id]
      : [],
  );
  if (!availableModels.includes(model)) {
    throw new ProviderSetupError("model_not_available", "Selected model is not available for this key", 400);
  }
}

function safeRecord(provider: ProviderRecord): SafeProviderRecord {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    status: provider.status,
    model: provider.model,
    authMode: provider.authMode,
    capabilities: provider.capabilities,
    createdAt: provider.createdAt,
  };
}

export async function createDeepSeekProviderSetup(
  database: DatabaseSync,
  secretStore: EncryptedSecretStore,
  input: DeepSeekProviderSetupInput,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<SafeProviderRecord> {
  validateInput(input);
  const repositories = createRepositories(database);
  if (repositories.providers.list().some((provider) => provider.name.toLowerCase() === "deepseek")) {
    throw new ProviderSetupError("duplicate_provider", "A DeepSeek provider is already configured", 409);
  }

  await assertCredentialAndModel(input.apiKey, input.model, fetcher);
  let secretReference: string | undefined;
  try {
    return withTransaction(database, () => {
      if (repositories.providers.list().some((provider) => provider.name.toLowerCase() === "deepseek")) {
        throw new ProviderSetupError("duplicate_provider", "A DeepSeek provider is already configured", 409);
      }
      secretReference = secretStore.put(input.apiKey);
      const provider = repositories.providers.create({
        id: randomUUID(),
        name: "DeepSeek",
        kind: "deepseek",
        status: "ready",
        model: input.model,
        authMode: "api_key",
        secretReference,
        capabilities: ["tools", "streaming"],
      });
      return safeRecord(provider);
    });
  } catch (error) {
    if (secretReference) {
      try {
        secretStore.delete(secretReference);
      } catch {
        // Preserve the database failure; do not leak secret-store implementation details.
      }
    }
    throw error;
  }
}
