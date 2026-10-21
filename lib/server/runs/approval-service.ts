import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../db/database";
import { canTransitionRunState, type RunState } from "../../domain/run-state";
import { createRepositories, type ApprovalRecord } from "../db/repositories";
import { withTransaction } from "../db/database";

export interface ApprovalScope {
  planVersion: number;
  baselineCommit: string | null;
  setupCommands: string[];
  verificationCommands: string[];
  permissions: string[];
  costLimitMicrounits: number;
}

export type RunTransitionActor = "owner" | "worker" | "system";

const SCOPE_FIELDS = [
  "baselineCommit",
  "costLimitMicrounits",
  "permissions",
  "planVersion",
  "setupCommands",
  "verificationCommands",
] as const;

function isStringList(value: unknown, maxItems = 100): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length <= 4096)
  );
}

function normalizeScope(
  value: ApprovalScope,
  allowedPermissions: ReadonlySet<string>,
): ApprovalScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Approval scope is invalid");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== SCOPE_FIELDS.length || keys.some((key, index) => key !== SCOPE_FIELDS[index])) {
    throw new Error("Approval scope contains unsupported fields");
  }
  if (!Number.isSafeInteger(value.planVersion) || value.planVersion < 1) {
    throw new Error("Approval plan version is invalid");
  }
  if (
    value.baselineCommit !== null &&
    (typeof value.baselineCommit !== "string" || value.baselineCommit.length === 0)
  ) {
    throw new Error("Approval baseline is invalid");
  }
  if (!isStringList(value.setupCommands) || !isStringList(value.verificationCommands)) {
    throw new Error("Approval commands are invalid");
  }
  if (
    value.setupCommands.some((command) => command.trim().length === 0) ||
    value.verificationCommands.some((command) => command.trim().length === 0)
  ) {
    throw new Error("Approval commands cannot be empty");
  }
  if (
    !isStringList(value.permissions, 64) ||
    value.permissions.some((permission) => permission.length === 0) ||
    new Set(value.permissions).size !== value.permissions.length
  ) {
    throw new Error("Approval permissions are invalid");
  }
  if (value.permissions.some((permission) => !allowedPermissions.has(permission))) {
    throw new Error("Approval requests a permission not allowed by server policy");
  }
  if (
    !Number.isSafeInteger(value.costLimitMicrounits) ||
    value.costLimitMicrounits <= 0
  ) {
    throw new Error("Approval cost limit must be a finite positive integer");
  }

  return {
    planVersion: value.planVersion,
    baselineCommit: value.baselineCommit,
    setupCommands: [...value.setupCommands],
    verificationCommands: [...value.verificationCommands],
    permissions: [...value.permissions],
    costLimitMicrounits: value.costLimitMicrounits,
  };
}

function serializeScope(scope: ApprovalScope): string {
  return JSON.stringify({
    planVersion: scope.planVersion,
    baselineCommit: scope.baselineCommit,
    setupCommands: scope.setupCommands,
    verificationCommands: scope.verificationCommands,
    permissions: scope.permissions,
    costLimitMicrounits: scope.costLimitMicrounits,
  });
}

function fingerprintScope(scopeJson: string): string {
  return createHash("sha256").update(scopeJson).digest("hex");
}

export function isApprovalFingerprintValid(
  scopeJson: string,
  expectedFingerprint: string,
): boolean {
  try {
    const parsed = JSON.parse(scopeJson) as unknown;
    return (
      JSON.stringify(parsed) === scopeJson &&
      fingerprintScope(scopeJson) === expectedFingerprint
    );
  } catch {
    return false;
  }
}

function scopeFromStoredJson(
  scopeJson: string,
  allowedPermissions: ReadonlySet<string>,
): ApprovalScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scopeJson);
  } catch {
    throw new Error("Stored approval scope is invalid");
  }
  return normalizeScope(parsed as ApprovalScope, allowedPermissions);
}

export function createApprovalService(
  database: Database,
  options: { allowedPermissions: readonly string[] },
) {
  const repositories = createRepositories(database);
  const allowedPermissions = new Set(options.allowedPermissions);

  async function readCurrentRun(runId: string) {
    const run = (await repositories.runs.getById(runId));
    if (!run) throw new Error("Run does not exist");
    return run;
  }

  function assertScopeMatchesRun(scope: ApprovalScope, run: Awaited<ReturnType<typeof readCurrentRun>>) {
    if (scope.planVersion !== run.planVersion) {
      throw new Error("Plan version changed; request a new approval");
    }
    if (scope.baselineCommit !== run.baselineCommit) {
      throw new Error("Repository baseline changed; request a new approval");
    }
  }

  async function submitForApproval(
    runId: string,
    input: ApprovalScope,
    onSubmitted?: (approval: ApprovalRecord) => void | Promise<void>,
  ) {
    const scope = normalizeScope(input, allowedPermissions);
    const scopeJson = serializeScope(scope);
    const fingerprint = fingerprintScope(scopeJson);
    const approvalId = (await withTransaction(database, async () => {
      const run = (await readCurrentRun(runId));
      assertScopeMatchesRun(scope, run);
      if (run.state !== "draft" && run.state !== "awaiting_approval") {
        throw new Error("Run is not available for approval");
      }
      if (
        !canTransitionRunState(run.state, "awaiting_approval") &&
        run.state !== "awaiting_approval"
      ) {
        throw new Error("Run cannot request approval from its current state");
      }

      const existing = (await repositories.approvals.listForRun(runId));
      const samePending = existing.find(
        (approval) =>
          approval.decision === "pending" &&
          approval.planVersion === scope.planVersion &&
          approval.payloadFingerprint === fingerprint,
      );
      if (samePending) {
        await onSubmitted?.(samePending);
        return samePending.id;
      }

      const sameVersionWithChangedScope = existing.some(
        (approval) =>
          approval.planVersion === scope.planVersion &&
          approval.payloadFingerprint !== fingerprint &&
          approval.decision !== "rejected",
      );
      if (sameVersionWithChangedScope) {
        throw new Error("Plan payload changed without a new plan version");
      }

      const id = randomUUID();
      const createdApproval = (await repositories.approvals.create({
        id,
        runId,
        payloadFingerprint: fingerprint,
        decision: "pending",
        planVersion: scope.planVersion,
        baselineCommit: scope.baselineCommit,
        scopeJson,
      }));

      if (run.state === "draft") {
        const result = (await database
          .prepare(
            `UPDATE runs SET state = 'awaiting_approval', updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND state = 'draft' AND plan_version = $2 AND baseline_commit IS NOT DISTINCT FROM $3`,
          )
          .run(runId, scope.planVersion, scope.baselineCommit));
        if (result.changes !== 1) throw new Error("Run changed while requesting approval");
      }

      (await repositories.events.append({
        runId,
        eventType: "approval.requested",
        payload: {
          approvalId: id,
          payloadFingerprint: fingerprint,
          planVersion: scope.planVersion,
          baselineCommit: scope.baselineCommit,
        },
      }));
      await onSubmitted?.(createdApproval);
      return id;
    }));

    return (await repositories.approvals.getById(approvalId))!;
  }

  async function decide(
    approvalId: string,
    input: {
      decision: "approved" | "rejected";
      expectedFingerprint: string;
    },
  ) {
    return (await withTransaction(database, async () => {
      const approval = (await repositories.approvals.getById(approvalId));
      if (!approval || approval.decision !== "pending") {
        throw new Error("Approval is not pending");
      }
      if (approval.payloadFingerprint !== input.expectedFingerprint) {
        throw new Error("Approval changed; review the current payload");
      }

      const scope = scopeFromStoredJson(approval.scopeJson, allowedPermissions);
      const scopeJson = serializeScope(scope);
      if (fingerprintScope(scopeJson) !== approval.payloadFingerprint) {
        throw new Error("Stored approval fingerprint is invalid");
      }

      const run = (await readCurrentRun(approval.runId));
      assertScopeMatchesRun(scope, run);
      if (run.state !== "awaiting_approval") {
        throw new Error("Run is no longer awaiting approval");
      }

      const nextState: RunState = input.decision === "approved" ? "queued" : "draft";
      if (!canTransitionRunState(run.state, nextState)) {
        throw new Error("Run cannot make this approval transition");
      }
      if (!(await repositories.approvals.updateDecision(approvalId, input.decision))) {
        throw new Error("Approval was already decided");
      }
      const transition = (await database
        .prepare(
          `UPDATE runs SET state = $1, updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND state = 'awaiting_approval' AND plan_version = $3 AND baseline_commit IS NOT DISTINCT FROM $4`,
        )
        .run(nextState, run.id, scope.planVersion, scope.baselineCommit));
      if (transition.changes !== 1) throw new Error("Run changed while deciding approval");

      (await repositories.events.append({
        runId: run.id,
        eventType: "approval.decided",
        payload: {
          approvalId,
          decision: input.decision,
          payloadFingerprint: approval.payloadFingerprint,
          planVersion: approval.planVersion,
          nextState,
        },
      }));
      return (await repositories.approvals.getById(approvalId))!;
    }));
  }

  async function isExecutionApproved(runId: string, input: ApprovalScope): Promise<boolean> {
    try {
      const scope = normalizeScope(input, allowedPermissions);
      const run = (await readCurrentRun(runId));
      if (
        !["queued", "running", "awaiting_review"].includes(run.state) ||
        scope.planVersion !== run.planVersion ||
        scope.baselineCommit !== run.baselineCommit
      ) {
        return false;
      }
      const expectedScope = serializeScope(scope);
      const expectedFingerprint = fingerprintScope(expectedScope);
      return (await repositories.approvals.listForRun(runId)).some((approval) => {
        if (
          approval.decision !== "approved" ||
          approval.planVersion !== run.planVersion ||
          approval.baselineCommit !== run.baselineCommit ||
          approval.payloadFingerprint !== expectedFingerprint
        ) {
          return false;
        }
        const stored = scopeFromStoredJson(approval.scopeJson, allowedPermissions);
        return serializeScope(stored) === expectedScope;
      });
    } catch {
      return false;
    }
  }

  async function transitionRun(
    runId: string,
    nextState: RunState,
    actor: RunTransitionActor,
  ) {
    if (!["owner", "worker", "system"].includes(actor)) {
      throw new Error("Model output cannot change run state");
    }
    return (await withTransaction(database, async () => {
      const run = (await readCurrentRun(runId));
      if (!canTransitionRunState(run.state, nextState)) {
        throw new Error("Run state transition is not allowed");
      }
      if (run.state === "awaiting_approval" && nextState === "queued") {
        throw new Error("An approved payload is required before queueing");
      }
      if (nextState === "done") {
        throw new Error("Completion requires verified acceptance criteria");
      }
      if (nextState === "running" && !(await isExecutionApprovedForStoredScope(runId))) {
        throw new Error("An approved payload is required before execution");
      }

      const result = (await database
        .prepare(
          "UPDATE runs SET state = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND state = $3",
        )
        .run(nextState, runId, run.state));
      if (result.changes !== 1) throw new Error("Run changed during state transition");
      (await repositories.events.append({
        runId,
        eventType: "run.state_changed",
        payload: { from: run.state, to: nextState, actor },
      }));
      return (await repositories.runs.getById(runId))!;
    }));
  }

  async function isExecutionApprovedForStoredScope(runId: string): Promise<boolean> {
    const run = (await repositories.runs.getById(runId));
    if (!run) return false;
    return (await repositories.approvals.listForRun(runId)).some((approval) => {
      if (
        approval.decision !== "approved" ||
        approval.planVersion !== run.planVersion ||
        approval.baselineCommit !== run.baselineCommit
      ) {
        return false;
      }
      try {
        const scope = scopeFromStoredJson(approval.scopeJson, allowedPermissions);
        return (
          scope.planVersion === run.planVersion &&
          scope.baselineCommit === run.baselineCommit &&
          fingerprintScope(serializeScope(scope)) === approval.payloadFingerprint
        );
      } catch {
        return false;
      }
    });
  }

  return { submitForApproval, decide, isExecutionApproved, transitionRun };
}
