import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApprovalDecisionHandler } from "../../../lib/server/orchestration/approval-action";
import { createRepositories, openDatabase } from "../../../lib/server/db/database";
import { createApprovalService } from "../../../lib/server/runs/approval-service";

const origin = "https://nail.example";
const permissions = ["workspace:read"];

function request(fingerprint: string, requestOrigin = origin) {
  return new Request(`${origin}/api/approvals/decision`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify({ decision: "approved", expectedFingerprint: fingerprint }),
  });
}

describe("approval mutation guard", () => {
  it("rejects unauthenticated and cross-origin requests before database access", async () => {
    const denied = createApprovalDecisionHandler({
      protectedResource: async () => new Response(null, { status: 401 }),
    }, undefined, origin, permissions);
    expect((await denied("invalid", request("a".repeat(64)))).status).toBe(401);
    const allowed = createApprovalDecisionHandler({
      protectedResource: async () => new Response(null, { status: 200 }),
    }, undefined, origin, permissions);
    expect((await allowed("invalid", request("a".repeat(64), "https://evil.example"))).status).toBe(403);
  });

  it("rejects a stale fingerprint without queueing, then accepts the exact reviewed payload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nail-approval-action-"));
    const path = join(directory, "db.sqlite");
    const db = openDatabase(path);
    try {
      const repos = createRepositories(db);
      repos.projects.create({ id: "p", name: "Project" });
      repos.runs.create({ id: "r", projectId: "p", state: "draft" });
      const approval = createApprovalService(db, { allowedPermissions: permissions })
        .submitForApproval("r", {
          planVersion: 1,
          baselineCommit: null,
          setupCommands: [],
          verificationCommands: [],
          permissions,
          costLimitMicrounits: 100,
        });
      const handler = createApprovalDecisionHandler({
        protectedResource: async () => new Response(null, { status: 200 }),
      }, path, origin, permissions);
      expect((await handler(approval.id, request("0".repeat(64)))).status).toBe(409);
      expect(repos.runs.getById("r")?.state).toBe("awaiting_approval");
      const response = await handler(approval.id, request(approval.payloadFingerprint));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ decision: "approved", runState: "queued" });
      expect(repos.runs.getById("r")?.state).toBe("queued");
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
