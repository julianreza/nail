import type { DatabaseSync } from "node:sqlite";
import type { ProviderStatus } from "../../domain/provider-status";
import type { ConnectionState, SubscriptionProviderKind } from "../../domain/subscription-provider";
import type { RunState } from "../../domain/run-state";
import type { VerificationStatus } from "../../domain/verification-result";

export interface ProjectRecord {
  id: string;
  name: string;
  repoUrl: string | null;
  baselineRef: string | null;
  baselineCommit: string | null;
  createdAt: string;
}

export interface AgentRecord {
  id: string;
  projectId: string | null;
  providerId: string | null;
  name: string;
  role: string;
  instructions: string;
  createdAt: string;
}

export type ProviderAuthMode = "api_key" | "subscription_cli" | "none";

export type ProviderKind = "deepseek" | SubscriptionProviderKind;

export interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind | null;
  status: ProviderStatus;
  model: string | null;
  authMode: ProviderAuthMode;
  secretReference: string | null;
  capabilities: string[];
  bindingGeneration: number;
  createdAt: string;
}

export interface ProviderAccountBindingRecord {
  providerId: string;
  bindingId: string;
  state: ConnectionState;
  reason: string | null;
  checkedAt: string | null;
  generation: number;
  revision: number;
}

export interface ConversationRecord {
  id: string;
  projectId: string;
  runId: string | null;
  actor: string;
  content: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  state: RunState;
  planVersion: number;
  baselineCommit: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  runId: string;
  ownerAgentId: string | null;
  title: string;
  state: string;
  position: number;
  createdAt: string;
}

export interface TaskDependencyRecord {
  taskId: string;
  dependsOnTaskId: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  payloadFingerprint: string;
  decision: "pending" | "approved" | "rejected";
  planVersion: number;
  baselineCommit: string | null;
  scopeJson: string;
  createdAt: string;
}

export interface LeaseRecord {
  workerId: string;
  runId: string;
  expiresAt: string;
}

export interface EventRecord<TPayload = unknown> {
  id: number;
  runId: string;
  eventType: string;
  payload: TPayload;
  createdAt: string;
}

export interface QaResultRecord {
  id: string;
  runId: string;
  taskId: string | null;
  status: VerificationStatus;
  details: string;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  kind: string;
  filePath: string;
  sizeBytes: number;
  createdAt: string;
}

export interface WorkspaceRecord {
  id: string;
  runId: string;
  projectId: string;
  sourcePath: string | null;
  workspacePath: string;
  baselinePath: string;
  baselineCommit: string | null;
  setupCommands: string[];
  verificationCommands: string[];
  state: "ready" | "blocked" | "closed";
  createdAt: string;
}

export interface CheckpointRecord {
  id: string;
  runId: string;
  taskId: string | null;
  baselineCommit: string | null;
  snapshotPath: string;
  changedFilesJson: string;
  createdAt: string;
}

export interface QaRoundRecord {
  id: string;
  runId: string;
  roundNumber: number;
  status: "passed" | "failed";
  details: string;
  createdAt: string;
}

export interface RunPlanRecord {
  runId: string;
  planVersion: number;
  goal: string;
  acceptanceCriteriaJson: string;
  setupCommandsJson: string;
  verificationCommandsJson: string;
  allowedToolsJson: string;
  approvalId: string;
  approvalFingerprint: string;
  createdAt: string;
}

export interface UsageRecord {
  id: string;
  runId: string;
  providerId: string | null;
  requestCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicrounits: number | null;
  usageState: "known" | "reserved" | "unknown";
  createdAt: string;
}

function mapRow<T>(row: unknown): T {
  const object = row as Record<string, unknown>;
  const mapped = Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
  return mapped as T;
}

function findById<T>(
  database: DatabaseSync,
  table: string,
  id: string,
): T | null {
  const row = database.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  return row === undefined ? null : mapRow<T>(row);
}

function listRecords<T>(database: DatabaseSync, table: string): T[] {
  return database
    .prepare(`SELECT * FROM ${table} ORDER BY created_at DESC, id DESC`)
    .all()
    .map((row) => mapRow<T>(row));
}

export function createRepositories(database: DatabaseSync) {
  const projects = {
    create(input: {
      id: string;
      name: string;
      repoUrl?: string | null;
      baselineRef?: string | null;
      baselineCommit?: string | null;
    }): ProjectRecord {
      database
        .prepare(
          `INSERT INTO projects (id, name, repo_url, baseline_ref, baseline_commit)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.repoUrl ?? null,
          input.baselineRef ?? null,
          input.baselineCommit ?? null,
        );
      return findById<ProjectRecord>(database, "projects", input.id)!;
    },
    getById(id: string): ProjectRecord | null {
      return findById(database, "projects", id);
    },
    list(): ProjectRecord[] {
      return listRecords(database, "projects");
    },
  };

  const agents = {
    create(input: {
      id: string;
      projectId?: string | null;
      providerId?: string | null;
      name: string;
      role: string;
      instructions?: string;
    }): AgentRecord {
      database
        .prepare(
          `INSERT INTO agents (id, project_id, provider_id, name, role, instructions)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId ?? null,
          input.providerId ?? null,
          input.name,
          input.role,
          input.instructions ?? "",
        );
      return findById<AgentRecord>(database, "agents", input.id)!;
    },
    getById(id: string): AgentRecord | null {
      return findById(database, "agents", id);
    },
    list(): AgentRecord[] {
      return listRecords(database, "agents");
    },
  };

  const providers = {
    create(input: {
      id: string;
      name: string;
      kind?: ProviderKind | null;
      status: ProviderStatus;
      model?: string | null;
      authMode: ProviderAuthMode;
      secretReference?: string | null;
      capabilities?: string[];
    }): ProviderRecord {
      const kind = input.kind ?? null;
      const secretReference = input.secretReference ?? null;
      if (input.authMode === "subscription_cli" && (!kind || secretReference !== null)) {
        throw new Error("Subscription providers require a kind and must not store a secret reference");
      }
      database
        .prepare(
          `INSERT INTO providers (id, name, kind, status, model, auth_mode, secret_reference, capabilities_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          kind,
          input.status,
          input.model ?? null,
          input.authMode,
          secretReference,
          JSON.stringify(input.capabilities ?? []),
        );
      return this.getById(input.id)!;
    },
    getById(id: string): ProviderRecord | null {
      const record = findById<Omit<ProviderRecord, "capabilities"> & { capabilitiesJson: string }>(
        database,
        "providers",
        id,
      );
      if (!record) return null;
      const { capabilitiesJson, ...provider } = record;
      return { ...provider, capabilities: JSON.parse(capabilitiesJson) as string[] };
    },
    updateStatus(id: string, status: ProviderStatus): boolean {
      return (
        database.prepare("UPDATE providers SET status = ? WHERE id = ?").run(status, id)
          .changes === 1
      );
    },
    advanceBindingGeneration(id: string): number | null {
      const update = database.prepare(
        `UPDATE providers SET binding_generation = binding_generation + 1
         WHERE id = ? AND auth_mode = 'subscription_cli' AND secret_reference IS NULL`,
      ).run(id);
      if (update.changes !== 1) return null;
      return this.getById(id)?.bindingGeneration ?? null;
    },
    updateSubscriptionConfiguration(id: string, model: string): boolean {
      if (!model || model.length > 128) throw new Error("Provider model is invalid");
      return database.prepare(
        `UPDATE providers SET model = ?, status = 'unavailable'
         WHERE id = ? AND auth_mode = 'subscription_cli'
           AND kind IS NOT NULL AND kind <> 'deepseek' AND secret_reference IS NULL`,
      ).run(model, id).changes === 1;
    },
    list(): ProviderRecord[] {
      return listRecords<
        Omit<ProviderRecord, "capabilities"> & { capabilitiesJson: string }
      >(database, "providers").map(({ capabilitiesJson, ...provider }) => ({
        ...provider,
        capabilities: JSON.parse(capabilitiesJson) as string[],
      }));
    },
  };

  const accountBindings = {
    create(input: {
      providerId: string;
      bindingId: string;
      state: ConnectionState;
    }): ProviderAccountBindingRecord {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.bindingId)) {
        throw new Error("Provider binding ID is invalid");
      }
      const provider = providers.getById(input.providerId);
      if (
        !provider ||
        provider.authMode !== "subscription_cli" ||
        provider.kind === null ||
        provider.kind === "deepseek" ||
        provider.secretReference !== null
      ) {
        throw new Error("Subscription binding requires a secret-free subscription provider");
      }
      database.prepare(
        `INSERT INTO provider_account_bindings (provider_id, binding_id, state, revision, generation)
         VALUES (?, ?, ?, 0, ?)`,
      ).run(input.providerId, input.bindingId, input.state, provider.bindingGeneration);
      return this.getByProviderId(input.providerId)!;
    },
    getByProviderId(providerId: string): ProviderAccountBindingRecord | null {
      const row = database.prepare(
        `SELECT provider_id AS providerId, binding_id AS bindingId, state,
                reason, checked_at AS checkedAt, generation, revision
         FROM provider_account_bindings WHERE provider_id = ?`,
      ).get(providerId);
      return row === undefined ? null : mapRow<ProviderAccountBindingRecord>(row);
    },
    updateDiagnostic(input: {
      providerId: string;
      bindingId: string;
      expectedRevision: number;
      expectedGeneration: number;
      state: ConnectionState;
      reason: string | null;
      checkedAt: string;
    }): boolean {
      if (
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 ||
        (input.reason !== null && input.reason.length > 256) ||
        input.checkedAt.length > 64
      ) {
        throw new Error("Provider binding diagnostic is invalid");
      }
      return database.prepare(
        `UPDATE provider_account_bindings
         SET state = ?, reason = ?, checked_at = ?, revision = revision + 1
         WHERE provider_id = ? AND binding_id = ? AND revision = ? AND generation = ?
           AND EXISTS (
             SELECT 1 FROM providers
             WHERE providers.id = provider_account_bindings.provider_id
               AND providers.binding_generation = ?
           )`,
      ).run(
        input.state,
        input.reason,
        input.checkedAt,
        input.providerId,
        input.bindingId,
        input.expectedRevision,
        input.expectedGeneration,
        input.expectedGeneration,
      ).changes === 1;
    },
    delete(providerId: string): boolean {
      return database.prepare(
        "DELETE FROM provider_account_bindings WHERE provider_id = ?",
      ).run(providerId).changes === 1;
    },
  };

  const conversations = {
    create(input: {
      id: string;
      projectId: string;
      runId?: string | null;
      actor: string;
      content: string;
    }): ConversationRecord {
      database
        .prepare(
          `INSERT INTO conversations (id, project_id, run_id, actor, content)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.projectId, input.runId ?? null, input.actor, input.content);
      return findById<ConversationRecord>(database, "conversations", input.id)!;
    },
    getById(id: string): ConversationRecord | null {
      return findById(database, "conversations", id);
    },
    list(): ConversationRecord[] {
      return listRecords(database, "conversations");
    },
  };

  const runs = {
    create(input: {
      id: string;
      projectId: string;
      state: RunState;
      planVersion?: number;
      baselineCommit?: string | null;
    }): RunRecord {
      database
        .prepare(
          `INSERT INTO runs (id, project_id, state, plan_version, baseline_commit)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.state,
          input.planVersion ?? 1,
          input.baselineCommit ?? null,
        );
      return findById<RunRecord>(database, "runs", input.id)!;
    },
    getById(id: string): RunRecord | null {
      return findById(database, "runs", id);
    },
    list(): RunRecord[] {
      return listRecords(database, "runs");
    },
  };

  const tasks = {
    create(input: {
      id: string;
      runId: string;
      ownerAgentId?: string | null;
      title: string;
      state?: string;
      position?: number;
    }): TaskRecord {
      database
        .prepare(
          `INSERT INTO tasks (id, run_id, owner_agent_id, title, state, position)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.runId,
          input.ownerAgentId ?? null,
          input.title,
          input.state ?? "queued",
          input.position ?? 0,
        );
      return findById<TaskRecord>(database, "tasks", input.id)!;
    },
    getById(id: string): TaskRecord | null {
      return findById(database, "tasks", id);
    },
    list(): TaskRecord[] {
      return listRecords(database, "tasks");
    },
    listForRun(runId: string): TaskRecord[] {
      return database
        .prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY position ASC, id ASC")
        .all(runId)
        .map((row) => mapRow<TaskRecord>(row));
    },
  };

  const taskDependencies = {
    set(taskId: string, dependsOnTaskIds: readonly string[]): void {
      const insert = database.prepare(
        "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
      );
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
        for (const dependencyId of dependsOnTaskIds) {
          insert.run(taskId, dependencyId);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    listForTask(taskId: string): TaskDependencyRecord[] {
      return database
        .prepare(
          "SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id",
        )
        .all(taskId)
        .map((row) => mapRow<TaskDependencyRecord>(row));
    },
  };

  const approvals = {
    create(input: {
      id: string;
      runId: string;
      payloadFingerprint: string;
      decision: ApprovalRecord["decision"];
      planVersion?: number;
      baselineCommit?: string | null;
      scopeJson?: string;
    }): ApprovalRecord {
      database
        .prepare(
          `INSERT INTO approvals (
             id, run_id, payload_fingerprint, decision, plan_version,
             baseline_commit, scope_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.runId,
          input.payloadFingerprint,
          input.decision,
          input.planVersion ?? 1,
          input.baselineCommit ?? null,
          input.scopeJson ?? "{}",
        );
      return findById<ApprovalRecord>(database, "approvals", input.id)!;
    },
    getById(id: string): ApprovalRecord | null {
      return findById(database, "approvals", id);
    },
    listForRun(runId: string): ApprovalRecord[] {
      return database
        .prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at DESC, id DESC")
        .all(runId)
        .map((row) => mapRow<ApprovalRecord>(row));
    },
    updateDecision(id: string, decision: ApprovalRecord["decision"]): boolean {
      return (
        database
          .prepare("UPDATE approvals SET decision = ? WHERE id = ? AND decision = 'pending'")
          .run(decision, id).changes === 1
      );
    },
    list(): ApprovalRecord[] {
      return listRecords(database, "approvals");
    },
  };

  const leases = {
    acquire(input: {
      workerId: string;
      runId: string;
      expiresAt: string;
      now: string;
    }): boolean {
      const result = database
        .prepare(
          `INSERT INTO leases (singleton_id, worker_id, run_id, expires_at)
           VALUES ('global', ?, ?, ?)
           ON CONFLICT(singleton_id) DO UPDATE SET
             worker_id = excluded.worker_id,
             run_id = excluded.run_id,
             expires_at = excluded.expires_at
           WHERE leases.expires_at <= ?`,
        )
        .run(input.workerId, input.runId, input.expiresAt, input.now);
      return result.changes === 1;
    },
    get(): LeaseRecord | null {
      const row = database
        .prepare(
          "SELECT worker_id, run_id, expires_at FROM leases WHERE singleton_id = 'global'",
        )
        .get();
      return row === undefined ? null : mapRow<LeaseRecord>(row);
    },
    release(workerId: string): boolean {
      return (
        database
          .prepare("DELETE FROM leases WHERE singleton_id = 'global' AND worker_id = ?")
          .run(workerId).changes === 1
      );
    },
  };

  const events = {
    append<TPayload>(input: {
      runId: string;
      eventType: string;
      payload: TPayload;
    }): EventRecord<TPayload> {
      const payloadJson = JSON.stringify(input.payload);
      if (payloadJson === undefined) {
        throw new Error("Event payload must be JSON serializable");
      }
      const result = database
        .prepare(
          "INSERT INTO events (run_id, event_type, payload_json) VALUES (?, ?, ?)",
        )
        .run(input.runId, input.eventType, payloadJson);
      const row = database
        .prepare("SELECT * FROM events WHERE id = ?")
        .get(Number(result.lastInsertRowid));
      const record = mapRow<Omit<EventRecord<TPayload>, "payload"> & { payloadJson: string }>(row);
      const { payloadJson: storedPayload, ...event } = record;
      return { ...event, payload: JSON.parse(storedPayload) as TPayload };
    },
    listAfter<TPayload = unknown>(
      runId: string,
      lastEventId: number,
      limit = 100,
    ): EventRecord<TPayload>[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("Event page size must be between 1 and 1000");
      }
      return database
        .prepare(
          `SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
        )
        .all(runId, lastEventId, limit)
        .map((row) => {
          const record = mapRow<
            Omit<EventRecord<TPayload>, "payload"> & { payloadJson: string }
          >(row);
          const { payloadJson, ...event } = record;
          return { ...event, payload: JSON.parse(payloadJson) as TPayload };
        });
    },
  };

  const qaResults = {
    create(input: {
      id: string;
      runId: string;
      taskId?: string | null;
      status: VerificationStatus;
      details?: string;
    }): QaResultRecord {
      database
        .prepare(
          `INSERT INTO qa_results (id, run_id, task_id, status, details)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.runId, input.taskId ?? null, input.status, input.details ?? "");
      return findById<QaResultRecord>(database, "qa_results", input.id)!;
    },
    getById(id: string): QaResultRecord | null {
      return findById(database, "qa_results", id);
    },
    list(): QaResultRecord[] {
      return listRecords(database, "qa_results");
    },
  };

  const artifacts = {
    create(input: {
      id: string;
      runId: string;
      kind: string;
      filePath: string;
      sizeBytes: number;
    }): ArtifactRecord {
      database
        .prepare(
          `INSERT INTO artifacts (id, run_id, kind, file_path, size_bytes)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.runId, input.kind, input.filePath, input.sizeBytes);
      return findById<ArtifactRecord>(database, "artifacts", input.id)!;
    },
    getById(id: string): ArtifactRecord | null {
      return findById(database, "artifacts", id);
    },
    list(): ArtifactRecord[] {
      return listRecords(database, "artifacts");
    },
  };

  function getWorkspaceById(id: string): WorkspaceRecord | null {
    const workspace = findById<
      Omit<WorkspaceRecord, "setupCommands" | "verificationCommands"> & {
        setupCommandsJson: string;
        verificationCommandsJson: string;
      }
    >(database, "run_workspaces", id);
    if (!workspace) return null;
    const { setupCommandsJson, verificationCommandsJson, ...record } = workspace;
    return {
      ...record,
      setupCommands: JSON.parse(setupCommandsJson) as string[],
      verificationCommands: JSON.parse(verificationCommandsJson) as string[],
    };
  }

  const workspaces = {
    create(input: {
      id: string;
      runId: string;
      projectId: string;
      sourcePath: string | null;
      workspacePath: string;
      baselinePath: string;
      baselineCommit: string | null;
      setupCommands: string[];
      verificationCommands: string[];
      state?: WorkspaceRecord["state"];
    }): WorkspaceRecord {
      database
        .prepare(
          `INSERT INTO run_workspaces (
             id, run_id, project_id, source_path, workspace_path, baseline_path,
             baseline_commit, setup_commands_json, verification_commands_json, state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.runId,
          input.projectId,
          input.sourcePath,
          input.workspacePath,
          input.baselinePath,
          input.baselineCommit,
          JSON.stringify(input.setupCommands),
          JSON.stringify(input.verificationCommands),
          input.state ?? "ready",
        );
      return getWorkspaceById(input.id)!;
    },
    getById(id: string): WorkspaceRecord | null {
      return getWorkspaceById(id);
    },
    getByRunId(runId: string): WorkspaceRecord | null {
      const row = database
        .prepare("SELECT id FROM run_workspaces WHERE run_id = ?")
        .get(runId) as { id: string } | undefined;
      return row ? getWorkspaceById(row.id) : null;
    },
  };

  const checkpoints = {
    create(input: {
      id: string;
      runId: string;
      taskId?: string | null;
      baselineCommit: string | null;
      snapshotPath: string;
      changedFilesJson: string;
    }): CheckpointRecord {
      database
        .prepare(
          `INSERT INTO checkpoints (
             id, run_id, task_id, baseline_commit, snapshot_path, changed_files_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.runId,
          input.taskId ?? null,
          input.baselineCommit,
          input.snapshotPath,
          input.changedFilesJson,
        );
      return findById<CheckpointRecord>(database, "checkpoints", input.id)!;
    },
    getById(id: string): CheckpointRecord | null {
      return findById(database, "checkpoints", id);
    },
    listForRun(runId: string): CheckpointRecord[] {
      return database
        .prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at DESC, id DESC")
        .all(runId)
        .map((row) => mapRow<CheckpointRecord>(row));
    },
  };

  const runPlans = {
    create(input: Omit<RunPlanRecord, "createdAt">): RunPlanRecord {
      database
        .prepare(
          `INSERT INTO run_plans (
             run_id, plan_version, goal, acceptance_criteria_json, setup_commands_json,
             verification_commands_json, allowed_tools_json, approval_id, approval_fingerprint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.planVersion,
          input.goal,
          input.acceptanceCriteriaJson,
          input.setupCommandsJson,
          input.verificationCommandsJson,
          input.allowedToolsJson,
          input.approvalId,
          input.approvalFingerprint,
        );
      return this.getByRunId(input.runId)!;
    },
    getByRunId(runId: string): RunPlanRecord | null {
      const row = database.prepare("SELECT * FROM run_plans WHERE run_id = ?").get(runId);
      return row === undefined ? null : mapRow<RunPlanRecord>(row);
    },
  };

  const qaRounds = {
    create(input: Omit<QaRoundRecord, "createdAt">): QaRoundRecord {
      database
        .prepare(
          `INSERT INTO qa_rounds (id, run_id, round_number, status, details)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.runId, input.roundNumber, input.status, input.details);
      return findById<QaRoundRecord>(database, "qa_rounds", input.id)!;
    },
    listForRun(runId: string): QaRoundRecord[] {
      return database
        .prepare("SELECT * FROM qa_rounds WHERE run_id = ? ORDER BY round_number ASC")
        .all(runId)
        .map((row) => mapRow<QaRoundRecord>(row));
    },
  };

  const usageRecords = {
    create(input: {
      id: string;
      runId: string;
      providerId?: string | null;
      requestCount?: number;
      toolCallCount?: number;
      inputTokens?: number;
      outputTokens?: number;
      estimatedCostMicrounits?: number | null;
      usageState?: UsageRecord["usageState"];
    }): UsageRecord {
      database
        .prepare(
          `INSERT INTO usage_records (
             id, run_id, provider_id, request_count, tool_call_count,
             input_tokens, output_tokens, estimated_cost_microunits, usage_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.runId,
          input.providerId ?? null,
          input.requestCount ?? 0,
          input.toolCallCount ?? 0,
          input.inputTokens ?? 0,
          input.outputTokens ?? 0,
          input.estimatedCostMicrounits ?? null,
          input.usageState ?? "known",
        );
      return findById<UsageRecord>(database, "usage_records", input.id)!;
    },
    getById(id: string): UsageRecord | null {
      return findById(database, "usage_records", id);
    },
    list(): UsageRecord[] {
      return listRecords(database, "usage_records");
    },
  };

  return {
    projects,
    agents,
    providers,
    accountBindings,
    conversations,
    runs,
    tasks,
    taskDependencies,
    approvals,
    leases,
    events,
    qaResults,
    artifacts,
    workspaces,
    checkpoints,
    runPlans,
    qaRounds,
    usageRecords,
  };
}

export type DatabaseRepositories = ReturnType<typeof createRepositories>;
