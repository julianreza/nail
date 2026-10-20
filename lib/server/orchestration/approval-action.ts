import type { DatabaseSync } from "node:sqlite";
import { openDatabase, createRepositories } from "../db/database";
import { isSameOriginRequest } from "../auth/auth-service";
import { createApprovalService } from "../runs/approval-service";
import { allowedRunPermissionsFromEnvironment } from "./policy";

interface AuthGuard {
  protectedResource(request: Request): Promise<Response>;
}

function json(body: object, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function readBoundedJson(request: Request, maxBytes = 4096): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

export function createApprovalDecisionHandler(
  auth: AuthGuard,
  databasePath: string | undefined,
  appOrigin: string | undefined,
  allowedPermissions: readonly string[] = allowedRunPermissionsFromEnvironment(),
) {
  return async function decideApproval(
    approvalId: string,
    request: Request,
  ): Promise<Response> {
    const session = await auth.protectedResource(request);
    if (!session.ok) return session;
    if (!appOrigin || !isSameOriginRequest(request, appOrigin)) {
      return json({ error: "Invalid origin" }, 403);
    }
    if (!databasePath) return json({ error: "Database is not configured" }, 503);
    if (!/^[0-9a-f-]{36}$/i.test(approvalId)) {
      return json({ error: "Approval not found" }, 404);
    }

    const body = await readBoundedJson(request);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(",") !== "decision,expectedFingerprint"
    ) {
      return json({ error: "Invalid approval decision" }, 400);
    }
    const input = body as Record<string, unknown>;
    if (
      (input.decision !== "approved" && input.decision !== "rejected") ||
      typeof input.expectedFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)
    ) {
      return json({ error: "Invalid approval decision" }, 400);
    }

    let database: DatabaseSync | undefined;
    try {
      database = openDatabase(databasePath);
      const repositories = createRepositories(database);
      const approval = repositories.approvals.getById(approvalId);
      if (!approval) return json({ error: "Approval not found" }, 404);
      const decided = createApprovalService(database, { allowedPermissions }).decide(
        approvalId,
        {
          decision: input.decision,
          expectedFingerprint: input.expectedFingerprint,
        },
      );
      return json({
        approvalId: decided.id,
        decision: decided.decision,
        runId: decided.runId,
        runState: repositories.runs.getById(decided.runId)?.state ?? null,
      }, 200);
    } catch {
      return json({ error: "Approval is stale or could not be changed" }, 409);
    } finally {
      database?.close();
    }
  };
}
