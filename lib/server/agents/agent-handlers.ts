import { isSameOriginRequest } from "../auth/auth-service";
import { parseAgentInput, type AgentInput } from "../../domain/agent";
import { openDatabase } from "../db/database";
import { createAgentService, AgentServiceError } from "./agent-service";

const MAX_BODY_BYTES = 64 * 1024;
const INVALID_REQUEST = { error: "Invalid request", code: "invalid_input" };

interface AuthGuard {
  protectedResource(request: Request): Promise<Response>;
}

interface AgentHandlerDependencies {
  auth: AuthGuard;
  appOrigin: string | undefined;
  databaseUrl: string | undefined;
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function authorize(
  dependencies: AgentHandlerDependencies,
  request: Request,
  mutation: boolean,
): Promise<Response | null> {
  let authorization: Response;
  try {
    authorization = await dependencies.auth.protectedResource(request);
  } catch {
    return json({ error: "Authentication is unavailable" }, 503);
  }
  if (!authorization.ok) return noStore(authorization);
  if (mutation && (!dependencies.appOrigin || !isSameOriginRequest(request, dependencies.appOrigin))) {
    return json({ error: "Invalid origin", code: "invalid_origin" }, 403);
  }
  if (mutation && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return json({ error: "Unsupported content type", code: "unsupported_content_type" }, 415);
  }
  if (!dependencies.databaseUrl) return json({ error: "Agent service is not configured" }, 503);
  return null;
}

async function readJson(request: Request): Promise<unknown | Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return json(INVALID_REQUEST, 400);
    if (length > MAX_BODY_BYTES) return json({ error: "Request body is too large", code: "request_too_large" }, 413);
  }
  if (!request.body) return json(INVALID_REQUEST, 400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return json({ error: "Request body is too large", code: "request_too_large" }, 413);
      }
      chunks.push(value);
    }
  } catch {
    return json(INVALID_REQUEST, 400);
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return json(INVALID_REQUEST, 400);
  }
}

function exactRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function handleError(error: unknown): Response {
  if (error instanceof AgentServiceError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  return json({ error: "Unable to load agent data" }, 500);
}

async function withAgentService<T>(
  dependencies: AgentHandlerDependencies,
  operation: (service: ReturnType<typeof createAgentService>) => Promise<T>,
  status = 200,
  wrapAgent = false,
): Promise<Response> {
  let database;
  try {
    database = await openDatabase(dependencies.databaseUrl!);
    const result = await operation(createAgentService(database));
    return json(wrapAgent ? { agent: result } : result, status);
  } catch (error) {
    return handleError(error);
  } finally {
    await database?.close();
  }
}

function inputFromBody(value: unknown): AgentInput | Response {
  try {
    return parseAgentInput(value);
  } catch {
    return json(INVALID_REQUEST, 400);
  }
}

export function createAgentHandlers(dependencies: AgentHandlerDependencies) {
  return {
    async list(request: Request): Promise<Response> {
      const denied = await authorize(dependencies, request, false);
      if (denied) return denied;
      return await withAgentService(dependencies, (service) => service.list());
    },

    async get(id: string, request: Request): Promise<Response> {
      const denied = await authorize(dependencies, request, false);
      if (denied) return denied;
      return await withAgentService(dependencies, (service) => service.get(id), 200, true);
    },

    async options(request: Request): Promise<Response> {
      const denied = await authorize(dependencies, request, false);
      if (denied) return denied;
      return await withAgentService(dependencies, (service) => service.options());
    },

    async create(request: Request): Promise<Response> {
      const denied = await authorize(dependencies, request, true);
      if (denied) return denied;
      const body = await readJson(request);
      if (body instanceof Response) return body;
      const input = inputFromBody(body);
      if (input instanceof Response) return input;
      return await withAgentService(dependencies, (service) => service.create(input), 201, true);
    },

    async update(id: string, request: Request): Promise<Response> {
      const denied = await authorize(dependencies, request, true);
      if (denied) return denied;
      const body = await readJson(request);
      if (body instanceof Response) return body;
      if (!exactRecord(body, ["revision", "agent"]) || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1) {
        return json(INVALID_REQUEST, 400);
      }
      const input = inputFromBody(body.agent);
      if (input instanceof Response) return input;
      return await withAgentService(
        dependencies,
        (service) => service.update(id, body.revision as number, input),
        200,
        true,
      );
    },

    async delete(id: string, request: Request): Promise<Response> {
      const denied = await authorize(dependencies, request, true);
      if (denied) return denied;
      const body = await readJson(request);
      if (body instanceof Response) return body;
      if (!exactRecord(body, ["revision"]) || !Number.isSafeInteger(body.revision) || (body.revision as number) < 1) {
        return json(INVALID_REQUEST, 400);
      }
      return await withAgentService(dependencies, async (service) => {
        await service.delete(id, body.revision as number);
        return { deleted: true, id };
      });
    },
  };
}
