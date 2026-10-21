import { openDatabase } from "../db/database";
import { isSameOriginRequest } from "../auth/auth-service";
import { createSecretStoreFromEnvironment } from "./secret-store";
import { createDeepSeekProviderSetup, ProviderSetupError } from "./provider-setup";

const MAX_REQUEST_BYTES = 24 * 1024;

interface ProviderSetupAuth {
  protectedResource(request: Request): Promise<Response>;
}

interface ProviderSetupDependencies {
  auth: ProviderSetupAuth;
  appOrigin: string | undefined;
  databaseUrl: string | undefined;
  createSecretStore?: typeof createSecretStoreFromEnvironment;
  fetcher?: typeof fetch;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function readBody(request: Request): Promise<string | null> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function createProviderSetupHandler(dependencies: ProviderSetupDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const authorization = await dependencies.auth.protectedResource(request);
    if (!authorization.ok) return authorization;
    if (!dependencies.appOrigin || !isSameOriginRequest(request, dependencies.appOrigin)) {
      return json({ error: "Invalid origin" }, 403);
    }
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
      return json({ error: "Unsupported content type" }, 415);
    }
    if (!dependencies.databaseUrl) return json({ error: "Provider setup is not configured" }, 503);

    const raw = await readBody(request);
    if (raw === null) return json({ error: "Request body is invalid or too large" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json({ error: "Invalid request" }, 400);
    }

    let database: Awaited<ReturnType<typeof openDatabase>> | undefined;
    try {
      const secretStore = (dependencies.createSecretStore ?? createSecretStoreFromEnvironment)();
      database = (await openDatabase(dependencies.databaseUrl));
      const provider = await createDeepSeekProviderSetup(
        database,
        secretStore,
        {
          apiKey: "apiKey" in body && typeof body.apiKey === "string" ? body.apiKey : "",
          model: "model" in body && typeof body.model === "string" ? body.model : "",
        },
        dependencies.fetcher,
      );
      return json(provider, 201);
    } catch (error) {
      if (error instanceof ProviderSetupError) {
        return json({ error: error.message, code: error.code }, error.status);
      }
      return json({ error: "Provider setup is unavailable" }, 503);
    } finally {
      await database?.close();
    }
  };
}
