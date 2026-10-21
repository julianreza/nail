import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { createApprovalService } from "../../../lib/server/runs/approval-service";
import {
  claimNextJob,
  recoverExpiredLease,
} from "../../../lib/server/queue/queue-service";
import { runWorkerOnce } from "../../../worker/runner";

const temporaryDirectories: string[] = [];
const now = "2026-10-19T10:00:00.000Z";

function createDatabaseIdentity(): string {
  const directory = mkdtempSync(join(tmpdir(), "nail-queue-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "orchestrator-database");
}

async function createApprovedRun() {
  const database = (await openDatabase(createDatabaseIdentity()));
  const repositories = createRepositories(database);
  (await repositories.projects.create({ id: "project-1", name: "Nail" }));
  (await repositories.runs.create({
    id: "run-1",
    projectId: "project-1",
    state: "draft",
    planVersion: 1,
    baselineCommit: "base-1",
  }));
  const approvals = createApprovalService(database, {
    allowedPermissions: ["workspace:read"],
  });
  const scope = {
    planVersion: 1,
    baselineCommit: "base-1",
    setupCommands: ["bun install"],
    verificationCommands: ["bun run lint"],
    permissions: ["workspace:read"],
    costLimitMicrounits: 1_000_000,
  };
  const approval = (await approvals.submitForApproval("run-1", scope));
  (await approvals.decide(approval.id, {
    decision: "approved",
    expectedFingerprint: approval.payloadFingerprint,
  }));
  return { database, repositories };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("persistent serial worker queue", () => {
  it("allows only one global worker claim", async () => {
    const { database, repositories } = (await createApprovedRun());
    try {
      const first = (await claimNextJob(database, {
        workerId: "worker-a",
        now,
        leaseDurationMs: 30_000,
      }));
      const second = (await claimNextJob(database, {
        workerId: "worker-b",
        now,
        leaseDurationMs: 30_000,
      }));

      expect(first).toMatchObject({ runId: "run-1", workerId: "worker-a" });
      expect(second).toBeNull();
      expect((await repositories.runs.getById("run-1"))?.state).toBe("running");
      expect((await repositories.leases.get())?.workerId).toBe("worker-a");
    } finally {
      (await database.close());
    }
  });

  it("fails closed until sandbox reconciliation, then marks stale work interrupted without requeue", async () => {
    const { database, repositories } = (await createApprovedRun());
    try {
      (await claimNextJob(database, {
        workerId: "worker-a",
        now,
        leaseDurationMs: 1000,
      }));
      const later = new Date(Date.parse(now) + 20_000).toISOString();

      expect(
        (await recoverExpiredLease(database, { now: later, sandboxReconciled: false })),
      ).toMatchObject({ recovered: false });
      expect((await repositories.runs.getById("run-1"))?.state).toBe("running");
      expect(
        (await recoverExpiredLease(database, { now: later, sandboxReconciled: true })),
      ).toMatchObject({ recovered: true, runId: "run-1" });
      expect((await repositories.runs.getById("run-1"))?.state).toBe("interrupted");
      expect((await repositories.leases.get())).toBeNull();
      expect(
        (await claimNextJob(database, {
          workerId: "worker-b",
          now: later,
          leaseDurationMs: 30_000,
        })),
      ).toBeNull();
    } finally {
      (await database.close());
    }
  });

  it("resumes event reads after a cursor without replaying prior events", async () => {
    const { database, repositories } = (await createApprovedRun());
    try {
      const cursor = (await repositories.events.append({
        runId: "run-1",
        eventType: "client.connected",
        payload: { cursor: true },
      }));
      (await claimNextJob(database, {
        workerId: "worker-a",
        now,
        leaseDurationMs: 30_000,
      }));

      const resumed = (await repositories.events.listAfter("run-1", cursor.id));
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.eventType).toBe("run.state_changed");
      expect((await repositories.events.listAfter("run-1", resumed[0]!.id))).toEqual([]);
    } finally {
      (await database.close());
    }
  });

  it("renews the lease while a job runs longer than one lease period", async () => {
    const { database, repositories } = (await createApprovedRun());
    try {
      const result = await runWorkerOnce({
        database,
        workerId: "worker-a",
        leaseDurationMs: 1000,
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1300));
          return { state: "awaiting_review" as const };
        },
      });

      expect(result).toMatchObject({ runId: "run-1", state: "awaiting_review", finalized: true });
      expect((await repositories.runs.getById("run-1"))?.state).toBe("awaiting_review");
      expect((await repositories.leases.get())).toBeNull();
    } finally {
      (await database.close());
    }
  });

  it("forwards cancellation to the job executor and releases the lease", async () => {
    const { database, repositories } = (await createApprovedRun());
    const cancellation = new AbortController();
    let started!: () => void;
    const jobStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    try {
      const job = runWorkerOnce({
        database,
        workerId: "worker-a",
        now: () => now,
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 10_000,
        signal: cancellation.signal,
        execute: async (_runId, signal) => {
          started();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { state: "cancelled" as const, reason: "owner_cancelled" };
        },
      });
      await jobStarted;
      cancellation.abort();
      await job;

      expect((await repositories.runs.getById("run-1"))?.state).toBe("cancelled");
      expect((await repositories.leases.get())).toBeNull();
    } finally {
      (await database.close());
    }
  });
});
