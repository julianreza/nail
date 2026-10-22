import "server-only";
import { getAuthHandlers } from "../../auth/auth-runtime";
import { getOwnerSessionBindingHash } from "../../auth/auth-service";
import { openDatabase } from "../../db/database";
import { createCodexDirectRepository } from "./repository";
import { createCodexDirectService } from "./service";
import { CodexDirectError } from "./types";
import { createCodexDirectHandlers, type DirectCodexService } from "./handlers";

export type CodexDirectOperation = "account" | "start" | "poll" | "cancel" | "disconnect" | "models" | "selectModel";

function decodeEncryptionKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new CodexDirectError("disabled");
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== value) throw new CodexDirectError("disabled");
  return key;
}

function serviceEnabled(): boolean {
  return process.env.NAIL_CODEX_DIRECT_ENABLED === "1";
}

async function createService() {
  const databaseUrl = process.env.DATABASE_URL;
  const clientId = process.env.NAIL_CODEX_DIRECT_CLIENT_ID;
  const clientVersion = process.env.NAIL_CODEX_DIRECT_CLIENT_VERSION;
  const encryptionKey = decodeEncryptionKey(process.env.NAIL_SECRET_ENCRYPTION_KEY);
  if (
    !databaseUrl || !clientId || clientId.trim() !== clientId ||
    !/^[\x21-\x7e]{1,200}$/.test(clientId) || /\s/.test(clientId) ||
    !clientVersion || !/^\d+\.\d+\.\d+$/.test(clientVersion)
  ) throw new CodexDirectError("disabled");
  const database = await openDatabase(databaseUrl);
  try {
    const service = createCodexDirectService({
      repository: createCodexDirectRepository(database),
      encryptionKey,
      clientId,
      clientVersion,
      fetcher: fetch,
      clock: Date.now,
    });
    return { service: service as DirectCodexService, close: () => database.close() };
  } catch (error) {
    await database.close();
    throw error;
  }
}

export async function handleCodexDirectOperation(operation: CodexDirectOperation, request: Request): Promise<Response> {
  const auth = getAuthHandlers();
  if (!auth) return Response.json({ error: "Authentication is not configured" }, { status: 503, headers: { "cache-control": "no-store" } });
  const handlers = createCodexDirectHandlers({
    auth,
    getAppOrigin: () => process.env.APP_ORIGIN,
    enabled: serviceEnabled,
    getSessionHash: (ownerRequest) => getOwnerSessionBindingHash(ownerRequest, process.env.SESSION_SECRET ?? ""),
    createService,
  });
  return handlers[operation](request);
}
