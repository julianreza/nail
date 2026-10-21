import type { Database } from "../db/database";
import { canTransitionRunState } from "../../domain/run-state";
import { createRepositories } from "../db/repositories";
import { withTransaction } from "../db/database";
import { isApprovalFingerprintValid } from "../runs/approval-service";

export interface ClaimedJob {
  workerId: string;
  runId: string;
  expiresAt: string;
}

function parseTime(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("A valid ISO timestamp is required");
  return time;
}

async function hasCurrentApproval(
  database: Database,
  run: { id: string; planVersion: number; baselineCommit: string | null },
): Promise<boolean> {
  const repositories = createRepositories(database);
  return (await repositories.approvals.listForRun(run.id)).some((approval) => {
    if (
      approval.decision !== "approved" ||
      approval.planVersion !== run.planVersion ||
      approval.baselineCommit !== run.baselineCommit ||
      !isApprovalFingerprintValid(approval.scopeJson, approval.payloadFingerprint)
    ) {
      return false;
    }
    try {
      const scope = JSON.parse(approval.scopeJson) as {
        planVersion?: unknown;
        baselineCommit?: unknown;
      };
      return (
        scope.planVersion === run.planVersion &&
        scope.baselineCommit === run.baselineCommit
      );
    } catch {
      return false;
    }
  });
}

export async function claimNextJob(
  database: Database,
  input: { workerId: string; now: string; leaseDurationMs: number },
): Promise<ClaimedJob | null> {
  if (!input.workerId.trim()) throw new Error("Worker ID is required");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1000) {
    throw new Error("Lease duration must be at least 1000 ms");
  }
  const nowMs = parseTime(input.now);
  const expiresAt = new Date(nowMs + input.leaseDurationMs).toISOString();

  return (await withTransaction(database, async () => {
    const repositories = createRepositories(database);
    const existingLease = (await repositories.leases.get());
    if (existingLease) {
      // Expired leases require explicit sandbox reconciliation before another run may start.
      return null;
    }

    const candidates = (await database
      .prepare("SELECT id FROM runs WHERE state = 'queued' ORDER BY created_at ASC, id ASC")
      .all()) as Array<{ id: string }>;

    for (const candidate of candidates) {
      const run = (await repositories.runs.getById(candidate.id));
      if (!run || !(await hasCurrentApproval(database, run))) continue;

      if (
        !(await repositories.leases.acquire({
          workerId: input.workerId,
          runId: run.id,
          expiresAt,
          now: input.now,
        }))
      ) {
        return null;
      }

      if (!canTransitionRunState(run.state, "running")) {
        (await repositories.leases.release(input.workerId));
        continue;
      }
      const changed = (await database
        .prepare(
          `UPDATE runs SET state = 'running', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND state = 'queued' AND plan_version = $2 AND baseline_commit IS NOT DISTINCT FROM $3`,
        )
        .run(run.id, run.planVersion, run.baselineCommit));
      if (changed.changes !== 1) {
        (await repositories.leases.release(input.workerId));
        continue;
      }

      (await repositories.events.append({
        runId: run.id,
        eventType: "run.state_changed",
        payload: { from: "queued", to: "running", actor: "worker" },
      }));
      return { workerId: input.workerId, runId: run.id, expiresAt };
    }

    return null;
  }));
}

export async function heartbeatLease(
  database: Database,
  input: {
    workerId: string;
    runId: string;
    now: string;
    leaseDurationMs: number;
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1000) {
    throw new Error("Lease duration must be at least 1000 ms");
  }
  const expiresAt = new Date(parseTime(input.now) + input.leaseDurationMs).toISOString();
  return withTransaction(database, async () => {
    const result = await database
      .prepare(
        `UPDATE leases SET expires_at = $1
         WHERE singleton_id = 'global' AND worker_id = $2 AND run_id = $3 AND expires_at > $4`,
      )
      .run(expiresAt, input.workerId, input.runId, input.now);
    return result.changes === 1;
  });
}

export async function recoverExpiredLease(
  database: Database,
  input: { now: string; sandboxReconciled: boolean },
): Promise<
  | { recovered: true; runId: string }
  | {
      recovered: false;
      reason: "no_lease" | "lease_active" | "sandbox_reconciliation_required";
    }
> {
  parseTime(input.now);
  return (await withTransaction(database, async () => {
    const repositories = createRepositories(database);
    const lease = (await repositories.leases.get());
    if (!lease) return { recovered: false, reason: "no_lease" } as const;
    if (parseTime(lease.expiresAt) > parseTime(input.now)) {
      return { recovered: false, reason: "lease_active" } as const;
    }
    if (!input.sandboxReconciled) {
      return {
        recovered: false,
        reason: "sandbox_reconciliation_required",
      } as const;
    }

    const run = (await repositories.runs.getById(lease.runId));
    if (run?.state === "running" && canTransitionRunState("running", "interrupted")) {
      const changed = (await database
        .prepare(
          `UPDATE runs SET state = 'interrupted', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND state = 'running'`,
        )
        .run(run.id));
      if (changed.changes !== 1) throw new Error("Run changed during lease recovery");
      (await repositories.events.append({
        runId: run.id,
        eventType: "run.state_changed",
        payload: {
          from: "running",
          to: "interrupted",
          reason: "worker_lease_expired",
          replayed: false,
        },
      }));
    }
    (await repositories.leases.release(lease.workerId));
    return { recovered: true, runId: lease.runId } as const;
  }));
}

export async function finishClaimedRun(
  database: Database,
  input: {
    workerId: string;
    runId: string;
    nextState: "awaiting_review" | "blocked" | "failed" | "cancelled";
    now: string;
  },
): Promise<boolean> {
  parseTime(input.now);
  return (await withTransaction(database, async () => {
    const repositories = createRepositories(database);
    const lease = (await repositories.leases.get());
    if (
      !lease ||
      lease.workerId !== input.workerId ||
      lease.runId !== input.runId ||
      parseTime(lease.expiresAt) <= parseTime(input.now)
    ) {
      return false;
    }
    const run = (await repositories.runs.getById(input.runId));
    if (!run || run.state !== "running" || !canTransitionRunState(run.state, input.nextState)) {
      return false;
    }

    const changed = (await database
      .prepare(
        `UPDATE runs SET state = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND state = 'running'`,
      )
      .run(input.nextState, input.runId));
    if (changed.changes !== 1) return false;
    if (!(await repositories.leases.release(input.workerId))) {
      throw new Error("Worker lease changed while finishing the run");
    }
    (await repositories.events.append({
      runId: input.runId,
      eventType: "run.state_changed",
      payload: { from: "running", to: input.nextState, actor: "worker" },
    }));
    return true;
  }));
}
