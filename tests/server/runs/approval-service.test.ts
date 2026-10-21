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

function createDatabaseIdentity(): string {
  const directory = mkdtempSync(join(tmpdir(), "nail-approval-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "orchestrator-database");
}

async function createRun(databaseUrl: string) {
  const database = (await openDatabase(databaseUrl));
  (await createRepositories(database).projects.create({ id: "project-1", name: "Nail" }));
  (await createRepositories(database).runs.create({
    id: "run-1",
    projectId: "project-1",
    state: "draft",
    planVersion: 1,
    baselineCommit: "base-1",
  }));
  return database;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("server-validated approvals", () => {
  it("requires exact approval before queueing and execution", async () => {
    const database = (await createRun(createDatabaseIdentity()));
    const service = createApprovalService(database, { allowedPermissions });
    try {
      const approval = (await service.submitForApproval("run-1", approvalScope));
      expect(approval.decision).toBe("pending");
      expect((await service.isExecutionApproved("run-1", approvalScope))).toBe(false);

      (await service.decide(approval.id, {
        decision: "approved",
        expectedFingerprint: approval.payloadFingerprint,
      }));

      expect((await createRepositories(database).runs.getById("run-1"))?.state).toBe("queued");
      expect((await service.isExecutionApproved("run-1", approvalScope))).toBe(true);
      expect(
        (await service.isExecutionApproved("run-1", {
          ...approvalScope,
          verificationCommands: ["bun run lint"],
        })),
      ).toBe(false);
    } finally {
      (await database.close());
    }
  });

  it("rejects approval when the plan version or repository baseline changed", async () => {
    for (const change of [
      "UPDATE runs SET plan_version = 2 WHERE id = 'run-1'",
      "UPDATE runs SET baseline_commit = 'base-2' WHERE id = 'run-1'",
    ]) {
      const database = (await createRun(createDatabaseIdentity()));
      const service = createApprovalService(database, { allowedPermissions });
      try {
        const approval = (await service.submitForApproval("run-1", approvalScope));
        (await database.exec(change));
        await expect(async () =>
          (await service.decide(approval.id, {
            decision: "approved",
            expectedFingerprint: approval.payloadFingerprint,
          })),
        ).rejects.toThrow();
        expect((await createRepositories(database).runs.getById("run-1"))?.state).toBe(
          "awaiting_approval",
        );
        expect((await createRepositories(database).approvals.getById(approval.id))?.decision).toBe(
          "pending",
        );
      } finally {
        (await database.close());
      }
    }
  });

  it("rejects stale UI fingerprints and permission expansion", async () => {
    const database = (await createRun(createDatabaseIdentity()));
    const service = createApprovalService(database, { allowedPermissions });
    try {
      const approval = (await service.submitForApproval("run-1", approvalScope));
      await expect(async () =>
        (await service.decide(approval.id, {
          decision: "approved",
          expectedFingerprint: "stale-fingerprint",
        })),
      ).rejects.toThrow();
      await expect(async () =>
        (await service.submitForApproval("run-1", {
          ...approvalScope,
          permissions: ["workspace:read", "production:deploy"],
        })),
      ).rejects.toThrow();
    } finally {
      (await database.close());
    }
  });

  it("rejects model-authored status fields and forbidden transitions", async () => {
    const database = (await createRun(createDatabaseIdentity()));
    const service = createApprovalService(database, { allowedPermissions });
    try {
      await expect(async () =>
        (await service.submitForApproval("run-1", {
          ...approvalScope,
          status: "done",
        } as ApprovalScope)),
      ).rejects.toThrow();
      await expect(async () => (await service.transitionRun("run-1", "done", "model" as never))).rejects.toThrow();
      await expect(async () => (await service.transitionRun("run-1", "running", "owner"))).rejects.toThrow();
      expect((await createRepositories(database).runs.getById("run-1"))?.state).toBe("draft");
    } finally {
      (await database.close());
    }
  });
});
