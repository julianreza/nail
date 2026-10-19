import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import {
  createApprovalService,
  type ApprovalScope,
} from "../../../lib/server/runs/approval-service";

const temporaryDirectories: string[] = [];
const allowedPermissions = ["workspace:read", "workspace:write"] as const;
const approvalScope: ApprovalScope = {
  planVersion: 1,
  baselineCommit: "base-1",
  setupCommands: ["bun install"],
  verificationCommands: ["bun run lint", "bun run build"],
  permissions: ["workspace:read", "workspace:write"],
  costLimitMicrounits: 5_000_000,
};

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nail-approval-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "orchestrator.sqlite");
}

function createRun(databasePath: string) {
  const database = openDatabase(databasePath);
  createRepositories(database).projects.create({ id: "project-1", name: "Nail" });
  createRepositories(database).runs.create({
    id: "run-1",
    projectId: "project-1",
    state: "draft",
    planVersion: 1,
    baselineCommit: "base-1",
  });
  return database;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("server-validated approvals", () => {
  it("requires exact approval before queueing and execution", () => {
    const database = createRun(createDatabasePath());
    const service = createApprovalService(database, { allowedPermissions });
    try {
      const approval = service.submitForApproval("run-1", approvalScope);
      expect(approval.decision).toBe("pending");
      expect(service.isExecutionApproved("run-1", approvalScope)).toBe(false);

      service.decide(approval.id, {
        decision: "approved",
        expectedFingerprint: approval.payloadFingerprint,
      });

      expect(createRepositories(database).runs.getById("run-1")?.state).toBe("queued");
      expect(service.isExecutionApproved("run-1", approvalScope)).toBe(true);
      expect(
        service.isExecutionApproved("run-1", {
          ...approvalScope,
          verificationCommands: ["bun run lint"],
        }),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  it("rejects approval when the plan version or repository baseline changed", () => {
    for (const change of [
      "UPDATE runs SET plan_version = 2 WHERE id = 'run-1'",
      "UPDATE runs SET baseline_commit = 'base-2' WHERE id = 'run-1'",
    ]) {
      const database = createRun(createDatabasePath());
      const service = createApprovalService(database, { allowedPermissions });
      try {
        const approval = service.submitForApproval("run-1", approvalScope);
        database.exec(change);
        expect(() =>
          service.decide(approval.id, {
            decision: "approved",
            expectedFingerprint: approval.payloadFingerprint,
          }),
        ).toThrow();
        expect(createRepositories(database).runs.getById("run-1")?.state).toBe(
          "awaiting_approval",
        );
        expect(createRepositories(database).approvals.getById(approval.id)?.decision).toBe(
          "pending",
        );
      } finally {
        database.close();
      }
    }
  });

  it("rejects stale UI fingerprints and permission expansion", () => {
    const database = createRun(createDatabasePath());
    const service = createApprovalService(database, { allowedPermissions });
    try {
      const approval = service.submitForApproval("run-1", approvalScope);
      expect(() =>
        service.decide(approval.id, {
          decision: "approved",
          expectedFingerprint: "stale-fingerprint",
        }),
      ).toThrow();
      expect(() =>
        service.submitForApproval("run-1", {
          ...approvalScope,
          permissions: ["workspace:read", "production:deploy"],
        }),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("rejects model-authored status fields and forbidden transitions", () => {
    const database = createRun(createDatabasePath());
    const service = createApprovalService(database, { allowedPermissions });
    try {
      expect(() =>
        service.submitForApproval("run-1", {
          ...approvalScope,
          status: "done",
        } as ApprovalScope),
      ).toThrow();
      expect(() => service.transitionRun("run-1", "done", "model" as never)).toThrow();
      expect(() => service.transitionRun("run-1", "running", "owner")).toThrow();
      expect(createRepositories(database).runs.getById("run-1")?.state).toBe("draft");
    } finally {
      database.close();
    }
  });
});
