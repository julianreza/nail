import { openDatabase, createRepositories } from "../lib/server/db/database";
import {
  claimNextJob,
  finishClaimedRun,
  heartbeatLease,
  recoverExpiredLease,
  type ClaimedJob,
} from "../lib/server/queue/queue-service";

export type WorkerOutcomeState = "awaiting_review" | "blocked" | "failed" | "cancelled";

export interface WorkerOutcome {
  state: WorkerOutcomeState;
}

export type JobExecutor = (
  runId: string,
  signal: AbortSignal,
) => Promise<WorkerOutcome>;

export interface RunWorkerOnceOptions {
  database: Awaited<ReturnType<typeof openDatabase>>;
  workerId: string;
  execute: JobExecutor;
  now?: () => string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  signal?: AbortSignal;
}

export interface WorkerRunResult {
  runId: string;
  state: WorkerOutcomeState;
  finalized: boolean;
}

export async function runWorkerOnce(
  options: RunWorkerOnceOptions,
): Promise<WorkerRunResult | null> {
  if (options.signal?.aborted) return null;
  const now = options.now ?? (() => new Date().toISOString());
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? Math.max(1, Math.floor(leaseDurationMs / 3));
  if (
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs < 1 ||
    heartbeatIntervalMs >= leaseDurationMs
  ) {
    throw new Error("Heartbeat interval must be shorter than the lease duration");
  }

  const claim = (await claimNextJob(options.database, {
    workerId: options.workerId,
    now: now(),
    leaseDurationMs,
  }));
  if (!claim) return null;

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();

  let leaseLost = false;
  let heartbeatStopped = false;
  let heartbeatPending = Promise.resolve();
  let heartbeat: ReturnType<typeof setTimeout>;
  const scheduleHeartbeat = () => {
    heartbeat = setTimeout(() => {
      heartbeatPending = (async () => {
        try {
          const renewed = await heartbeatLease(options.database, {
            workerId: claim.workerId, runId: claim.runId, now: now(), leaseDurationMs,
          });
          if (!renewed) throw new Error("Worker lease was lost");
        } catch {
          leaseLost = true;
          controller.abort("worker_lease_lost");
        }
        if (!heartbeatStopped && !leaseLost) scheduleHeartbeat();
      })();
    }, heartbeatIntervalMs);
  };
  const stopHeartbeat = async () => {
    heartbeatStopped = true;
    clearTimeout(heartbeat);
    await heartbeatPending;
  };
  scheduleHeartbeat();

  try {
    const outcome = await options.execute(claim.runId, controller.signal);
    await stopHeartbeat();
    const state = controller.signal.aborted ? "cancelled" : outcome.state;
    const finalized =
      !leaseLost &&
      (await finishClaimedRun(options.database, {
        workerId: claim.workerId,
        runId: claim.runId,
        nextState: state,
        now: now(),
      }));
    return { runId: claim.runId, state, finalized };
  } catch {
    await stopHeartbeat();
    const state: WorkerOutcomeState = controller.signal.aborted ? "cancelled" : "failed";
    const finalized =
      !leaseLost &&
      (await finishClaimedRun(options.database, {
        workerId: claim.workerId,
        runId: claim.runId,
        nextState: state,
        now: now(),
      }));
    return { runId: claim.runId, state, finalized };
  } finally {
    await stopHeartbeat();
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export interface StartWorkerOptions {
  databaseUrl: string;
  workerId: string;
  execute: JobExecutor;
  reconcileExpiredLease?: (lease: NonNullable<Awaited<ReturnType<ReturnType<typeof createRepositories>["leases"]["get"]>>>) => Promise<boolean>;
  now?: () => string;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
}

export interface WorkerProcessHandle {
  stop(): void;
  completion: Promise<void>;
}

export async function startWorkerProcess(options: StartWorkerOptions): Promise<WorkerProcessHandle> {
  const database = (await openDatabase(options.databaseUrl));
  const controller = new AbortController();
  const now = options.now ?? (() => new Date().toISOString());
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    (await database.close());
    throw new Error("Poll interval must be a positive integer");
  }

  const completion = (async () => {
    try {
      while (!controller.signal.aborted) {
        const staleLease = (await createRepositories(database).leases.get());
        if (staleLease && Date.parse(staleLease.expiresAt) <= Date.parse(now())) {
          const sandboxReconciled =
            (await options.reconcileExpiredLease?.(staleLease)) ?? false;
          (await recoverExpiredLease(database, {
            now: now(),
            sandboxReconciled,
          }));
        }
        if (controller.signal.aborted) break;

        const result = await runWorkerOnce({
          database,
          workerId: options.workerId,
          execute: options.execute,
          now,
          leaseDurationMs: options.leaseDurationMs,
          heartbeatIntervalMs: options.heartbeatIntervalMs,
          signal: controller.signal,
        });
        if (!result) await waitForPoll(pollIntervalMs, controller.signal);
      }
    } finally {
      (await database.close());
    }
  })();

  return {
    stop() {
      controller.abort("worker_stopped");
    },
    completion,
  };
}

export type { ClaimedJob };
