import type { DatabaseSync } from "node:sqlite";
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

function hasCurrentApproval(
  database: DatabaseSync,
  run: { id: string; planVersion: number; baselineCommit: string | null },
): boolean {
  const repositories = createRepositories(database);
  return repositories.approvals.listForRun(run.id).some((approval) => {
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

export function claimNextJob(
  database: DatabaseSync,
  input: { workerId: string; now: string; leaseDurationMs: number },
): ClaimedJob | null {
  if (!input.workerId.trim()) throw new Error("Worker ID is required");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1000) {
    throw new Error("Lease duration must be at least 1000 ms");
  }
  const nowMs = parseTime(input.now);
  const expiresAt = new Date(nowMs + input.leaseDurationMs).toISOString();

  return withTransaction(database, () => {
    const repositories = createRepositories(database);
    const existingLease = repositories.leases.get();
    if (existingLease) {
      // Expired leases require explicit sandbox reconciliation before another run may start.
      return null;
    }

    const candidates = database
      .prepare("SELECT id FROM runs WHERE state = 'queued' ORDER BY created_at ASC, id ASC")
      .all() as Array<{ id: string }>;

    for (const candidate of candidates) {
      const run = repositories.runs.getById(candidate.id);
      if (!run || !hasCurrentApproval(database, run)) continue;

      if (
        !repositories.leases.acquire({
          workerId: input.workerId,
          runId: run.id,
          expiresAt,
          now: input.now,
        })
      ) {
        return null;
      }

      if (!canTransitionRunState(run.state, "running")) {
        repositories.leases.release(input.workerId);
        continue;
      }
      const changed = database
        .prepare(
          `UPDATE runs SET state = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ? AND state = 'queued' AND plan_version = ? AND baseline_commit IS ?`,
        )
        .run(run.id, run.planVersion, run.baselineCommit);
      if (changed.changes !== 1) {
        repositories.leases.release(input.workerId);
        continue;
      }

      repositories.events.append({
        runId: run.id,
        eventType: "run.state_changed",
        payload: { from: "queued", to: "running", actor: "worker" },
      });
      return { workerId: input.workerId, runId: run.id, expiresAt };
    }

    return null;
  });
}

export function heartbeatLease(
  database: DatabaseSync,
  input: {
    workerId: string;
    runId: string;
    now: string;
    leaseDurationMs: number;
  },
): boolean {
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1000) {
    throw new Error("Lease duration must be at least 1000 ms");
  }
  const expiresAt = new Date(parseTime(input.now) + input.leaseDurationMs).toISOString();
  const result = database
    .prepare(
      `UPDATE leases SET expires_at = ?
       WHERE singleton_id = 'global' AND worker_id = ? AND run_id = ? AND expires_at > ?`,
    )
    .run(expiresAt, input.workerId, input.runId, input.now);
  return result.changes === 1;
}

export function recoverExpiredLease(
  database: DatabaseSync,
  input: { now: string; sandboxReconciled: boolean },
):
  | { recovered: true; runId: string }
  | {
      recovered: false;
      reason: "no_lease" | "lease_active" | "sandbox_reconciliation_required";
    } {
  parseTime(input.now);
  return withTransaction(database, () => {
    const repositories = createRepositories(database);
    const lease = repositories.leases.get();
    if (!lease) return { recovered: false, reason: "no_lease" } as const;
    if (lease.expiresAt > input.now) {
      return { recovered: false, reason: "lease_active" } as const;
    }
    if (!input.sandboxReconciled) {
      return {
        recovered: false,
        reason: "sandbox_reconciliation_required",
      } as const;
    }

    const run = repositories.runs.getById(lease.runId);
    if (run?.state === "running" && canTransitionRunState("running", "interrupted")) {
      const changed = database
        .prepare(
          `UPDATE runs SET state = 'interrupted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ? AND state = 'running'`,
        )
        .run(run.id);
      if (changed.changes !== 1) throw new Error("Run changed during lease recovery");
      repositories.events.append({
        runId: run.id,
        eventType: "run.state_changed",
        payload: {
          from: "running",
          to: "interrupted",
          reason: "worker_lease_expired",
          replayed: false,
        },
      });
    }
    repositories.leases.release(lease.workerId);
    return { recovered: true, runId: lease.runId } as const;
  });
}

export function finishClaimedRun(
  database: DatabaseSync,
  input: {
    workerId: string;
    runId: string;
    nextState: "awaiting_review" | "blocked" | "failed" | "cancelled";
    now: string;
  },
): boolean {
  parseTime(input.now);
  return withTransaction(database, () => {
    const repositories = createRepositories(database);
    const lease = repositories.leases.get();
    if (
      !lease ||
      lease.workerId !== input.workerId ||
      lease.runId !== input.runId ||
      lease.expiresAt <= input.now
    ) {
      return false;
    }
    const run = repositories.runs.getById(input.runId);
    if (!run || run.state !== "running" || !canTransitionRunState(run.state, input.nextState)) {
      return false;
    }

    const changed = database
      .prepare(
        `UPDATE runs SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = 'running'`,
      )
      .run(input.nextState, input.runId);
    if (changed.changes !== 1) return false;
    if (!repositories.leases.release(input.workerId)) {
      throw new Error("Worker lease changed while finishing the run");
    }
    repositories.events.append({
      runId: input.runId,
      eventType: "run.state_changed",
      payload: { from: "running", to: input.nextState, actor: "worker" },
    });
    return true;
  });
}
