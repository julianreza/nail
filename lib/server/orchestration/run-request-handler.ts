import type { Database } from "../db/database";
import { isSameOriginRequest } from "../auth/auth-service";
import { openDatabase, createRepositories } from "../db/database";
import type { RunPlanPolicy } from "./run-request";
import { createRunPlanFromGoal, type CreatePlanRequest, type PlanGenerator } from "./run-request";
import { SubscriptionProviderError } from "../providers/subscription-errors";
import { ProviderSetupError } from "../providers/provider-setup";
import {
  ProviderAuthenticationError,
  ProviderConfigurationError,
  ProviderRequestError,
  ProviderUnavailableError,
} from "../providers/deepseek-adapter";
import { UsageBudgetExceededError } from "../providers/usage-budget";

const MAX_REQUEST_BYTES = 1024 * 1024;
const REQUEST_FIELDS = [
  "providerId",
  "goal",
  "setupCommands",
  "verificationCommands",
  "maxRequests",
  "maxToolCalls",
  "maxOutputTokens",
  "costLimitMicrounits",
] as const;

interface AuthGuard {
  protectedResource(request: Request): Promise<Response>;
}

interface RunRequestHandlerDependencies {
  auth: AuthGuard;
  appOrigin: string | undefined;
  databaseUrl: string | undefined;
  policy: RunPlanPolicy;
  createPlanGenerator(database: Database): PlanGenerator;
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
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

function parseBody(value: unknown): Omit<CreatePlanRequest, "projectId"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  const expected = [...REQUEST_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (
    typeof body.providerId !== "string" || !body.providerId || body.providerId.length > 128 ||
    typeof body.goal !== "string" || body.goal.trim().length === 0 || body.goal.length > 5000 ||
    !Array.isArray(body.setupCommands) || body.setupCommands.length > 100 ||
    !body.setupCommands.every((command) => typeof command === "string" && command.trim().length > 0 && command.length <= 4096) ||
    !Array.isArray(body.verificationCommands) || body.verificationCommands.length > 100 ||
    !body.verificationCommands.every((command) => typeof command === "string" && command.trim().length > 0 && command.length <= 4096) ||
    !Number.isSafeInteger(body.maxRequests) || (body.maxRequests as number) < 1 || (body.maxRequests as number) > 1000 ||
    !Number.isSafeInteger(body.maxToolCalls) || (body.maxToolCalls as number) < 1 || (body.maxToolCalls as number) > 10000 ||
    !Number.isSafeInteger(body.maxOutputTokens) || (body.maxOutputTokens as number) < 1 || (body.maxOutputTokens as number) > 32768 ||
    !Number.isSafeInteger(body.costLimitMicrounits) || (body.costLimitMicrounits as number) < 1
  ) return null;
  return body as unknown as Omit<CreatePlanRequest, "projectId">;
}

function errorResponse(error: unknown): Response {
  if (error instanceof SubscriptionProviderError || error instanceof ProviderSetupError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof ProviderAuthenticationError) return json({ error: error.message }, 401);
  if (error instanceof UsageBudgetExceededError) return json({ error: error.message }, 429);
  if (error instanceof ProviderUnavailableError || error instanceof ProviderConfigurationError) {
    return json({ error: error.message }, 503);
  }
  if (error instanceof ProviderRequestError) return json({ error: "Provider rejected the plan request" }, 502);
  return json({ error: "Plan generation failed; the run was not approved" }, 502);
}

export function createRunRequestHandler(dependencies: RunRequestHandlerDependencies) {
  return async function POST(projectId: string, request: Request): Promise<Response> {
    const authorization = await dependencies.auth.protectedResource(request);
    if (!authorization.ok) return authorization;
    if (!dependencies.appOrigin || !isSameOriginRequest(request, dependencies.appOrigin)) {
      return json({ error: "Invalid origin" }, 403);
    }
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
      return json({ error: "Unsupported content type" }, 415);
    }
    if (!dependencies.databaseUrl) return json({ error: "Database is not configured" }, 503);
    if (typeof projectId !== "string" || !projectId || projectId.length > 128) {
      return json({ error: "Project not found" }, 404);
    }

    const raw = await readBody(request);
    if (raw === null) return json({ error: "Request body is invalid or too large" }, 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
    const body = parseBody(parsed);
    if (!body) return json({ error: "Run request is invalid" }, 400);

    let database: Database | undefined;
    try {
      database = (await openDatabase(dependencies.databaseUrl));
      const project = (await createRepositories(database).projects.getById(projectId));
      if (!project) return json({ error: "Project not found" }, 404);
      const result = await createRunPlanFromGoal(
        database,
        { ...body, projectId },
        dependencies.policy,
        dependencies.createPlanGenerator(database),
      );
      return json(result, 201);
    } catch (error) {
      return errorResponse(error);
    } finally {
      (await database?.close());
    }
  };
}
