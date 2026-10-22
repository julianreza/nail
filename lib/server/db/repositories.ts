import type { Database } from "./database";
import { withTransaction } from "./database";
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
  model: string | null;
  skillIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type ProviderAuthMode = "api_key" | "subscription_cli" | "subscription_oauth" | "none";

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

function mapAgentRow(row: unknown): AgentRecord {
  const { skillIdsJson, ...agent } = mapRow<Omit<AgentRecord, "skillIds"> & { skillIdsJson: string }>(row);
  return { ...agent, skillIds: JSON.parse(skillIdsJson) as string[] };
}

async function findById<T>(
  database: Database,
  table: string,
  id: string,
): Promise<T | null> {
  const row = (await database.prepare(`SELECT * FROM ${table} WHERE id = $1`).get(id));
  return row === undefined ? null : mapRow<T>(row);
}

async function listRecords<T>(database: Database, table: string): Promise<T[]> {
  return (await database
    .prepare(`SELECT * FROM ${table} ORDER BY created_at DESC, id DESC`)
    .all())
    .map((row) => mapRow<T>(row));
}

export function createRepositories(database: Database) {
  const projects = {
    async create(input: {
      id: string;
      name: string;
      repoUrl?: string | null;
      baselineRef?: string | null;
      baselineCommit?: string | null;
    }): Promise<ProjectRecord> {
      (await database
        .prepare(
          `INSERT INTO projects (id, name, repo_url, baseline_ref, baseline_commit)
           VALUES ($1, $2, $3, $4, $5)`,
        )
        .run(
          input.id,
          input.name,
          input.repoUrl ?? null,
          input.baselineRef ?? null,
          input.baselineCommit ?? null,
        ));
      return (await findById<ProjectRecord>(database, "projects", input.id))!;
    },
    async getById(id: string): Promise<ProjectRecord | null> {
      return (await findById(database, "projects", id));
    },
    async list(): Promise<ProjectRecord[]> {
      return (await listRecords(database, "projects"));
    },
  };

  const agents = {
    async create(input: {
      id: string;
      projectId?: string | null;
      providerId?: string | null;
      name: string;
      role: string;
      instructions?: string;
      model?: string | null;
      skillIds?: string[];
    }): Promise<AgentRecord> {
      await database.prepare(
        `INSERT INTO agents (
           id, project_id, provider_id, name, role, instructions, model, skill_ids_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ).run(
        input.id,
        input.projectId ?? null,
        input.providerId ?? null,
        input.name,
        input.role,
        input.instructions ?? "",
        input.model ?? null,
        JSON.stringify(input.skillIds ?? []),
      );
      return (await this.getById(input.id))!;
    },
    async getById(id: string): Promise<AgentRecord | null> {
      const row = await database.prepare("SELECT * FROM agents WHERE id = $1").get(id);
      return row === undefined ? null : mapAgentRow(row);
    },
    async list(): Promise<AgentRecord[]> {
      return (await database.prepare("SELECT * FROM agents ORDER BY created_at ASC, id ASC").all())
        .map(mapAgentRow);
    },
    async updateConfiguration(input: {
      id: string;
      revision: number;
      projectId: string | null;
      providerId: string | null;
      model: string | null;
      name: string;
      role: string;
      instructions: string;
      skillIds: string[];
    }): Promise<boolean> {
      return (await database.prepare(
        `UPDATE agents SET project_id = $1, provider_id = $2, model = $3,
           name = $4, role = $5, instructions = $6, skill_ids_json = $7,
           revision = revision + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $8 AND revision = $9`,
      ).run(
        input.projectId,
        input.providerId,
        input.model,
        input.name,
        input.role,
        input.instructions,
        JSON.stringify(input.skillIds),
        input.id,
        input.revision,
      )).changes === 1;
    },
    async deleteIfRevision(id: string, revision: number): Promise<boolean> {
      return (await database.prepare(
        "DELETE FROM agents WHERE id = $1 AND revision = $2",
      ).run(id, revision)).changes === 1;
    },
  };

  const providers = {
    async create(input: {
      id: string;
      name: string;
      kind?: ProviderKind | null;
      status: ProviderStatus;
      model?: string | null;
      authMode: ProviderAuthMode;
      secretReference?: string | null;
      capabilities?: string[];
    }): Promise<ProviderRecord> {
      const kind = input.kind ?? null;
      const secretReference = input.secretReference ?? null;
      const capabilities = input.capabilities ?? [];
      if (input.authMode === "subscription_cli" && (!kind || secretReference !== null)) {
        throw new Error("Subscription providers require a kind and must not store a secret reference");
      }
      if (
        input.authMode === "subscription_oauth" &&
        (kind !== "codex" || secretReference !== null || input.status === "ready" || capabilities.length !== 0)
      ) throw new Error("Direct OAuth providers must be unavailable, Codex-only and secret-free");
      (await database
        .prepare(
          `INSERT INTO providers (id, name, kind, status, model, auth_mode, secret_reference, capabilities_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
        ));
      return (await this.getById(input.id))!;
    },
    async getById(id: string): Promise<ProviderRecord | null> {
      const record = (await findById<Omit<ProviderRecord, "capabilities"> & { capabilitiesJson: string }>(
        database,
        "providers",
        id,
      ));
      if (!record) return null;
      const { capabilitiesJson, ...provider } = record;
      return { ...provider, capabilities: JSON.parse(capabilitiesJson) as string[] };
    },
    async updateStatus(id: string, status: ProviderStatus): Promise<boolean> {
      return (
        (await database.prepare("UPDATE providers SET status = $1 WHERE id = $2").run(status, id))
          .changes === 1
      );
    },
    async advanceBindingGeneration(id: string): Promise<number | null> {
      const update = (await database.prepare(
        `UPDATE providers SET binding_generation = binding_generation + 1
         WHERE id = $1 AND auth_mode = 'subscription_cli' AND secret_reference IS NULL`,
      ).run(id));
      if (update.changes !== 1) return null;
      return (await this.getById(id))?.bindingGeneration ?? null;
    },
    async updateSubscriptionConfiguration(id: string, model: string): Promise<boolean> {
      if (!model || model.length > 128) throw new Error("Provider model is invalid");
      return (await database.prepare(
        `UPDATE providers SET model = $1, status = 'unavailable'
         WHERE id = $2 AND auth_mode = 'subscription_cli'
           AND kind IS NOT NULL AND kind <> 'deepseek' AND secret_reference IS NULL`,
      ).run(model, id)).changes === 1;
    },
    async list(): Promise<ProviderRecord[]> {
      return (await listRecords<
        Omit<ProviderRecord, "capabilities"> & { capabilitiesJson: string }
      >(database, "providers")).map(({ capabilitiesJson, ...provider }) => ({
        ...provider,
        capabilities: JSON.parse(capabilitiesJson) as string[],
      }));
    },
  };

  const accountBindings = {
    async create(input: {
      providerId: string;
      bindingId: string;
      state: ConnectionState;
    }): Promise<ProviderAccountBindingRecord> {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.bindingId)) {
        throw new Error("Provider binding ID is invalid");
      }
      const provider = (await providers.getById(input.providerId));
      if (
        !provider ||
        provider.authMode !== "subscription_cli" ||
        provider.kind === null ||
        provider.kind === "deepseek" ||
        provider.secretReference !== null
      ) {
        throw new Error("Subscription binding requires a secret-free subscription provider");
      }
      (await database.prepare(
        `INSERT INTO provider_account_bindings (provider_id, binding_id, state, revision, generation)
         VALUES ($1, $2, $3, 0, $4)`,
      ).run(input.providerId, input.bindingId, input.state, provider.bindingGeneration));
      return (await this.getByProviderId(input.providerId))!;
    },
    async getByProviderId(providerId: string): Promise<ProviderAccountBindingRecord | null> {
      const row = (await database.prepare(
        `SELECT provider_id AS "providerId", binding_id AS "bindingId", state,
                reason, checked_at AS "checkedAt", generation, revision
         FROM provider_account_bindings WHERE provider_id = $1`,
      ).get(providerId));
      return row === undefined ? null : mapRow<ProviderAccountBindingRecord>(row);
    },
    async updateDiagnostic(input: {
      providerId: string;
      bindingId: string;
      expectedRevision: number;
      expectedGeneration: number;
      state: ConnectionState;
      reason: string | null;
      checkedAt: string;
    }): Promise<boolean> {
      if (
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0 ||
        (input.reason !== null && input.reason.length > 256) ||
        input.checkedAt.length > 64
      ) {
        throw new Error("Provider binding diagnostic is invalid");
      }
      return (await database.prepare(
        `UPDATE provider_account_bindings
         SET state = $1, reason = $2, checked_at = $3, revision = revision + 1
         WHERE provider_id = $4 AND binding_id = $5 AND revision = $6 AND generation = $7
           AND EXISTS (
             SELECT 1 FROM providers
             WHERE providers.id = provider_account_bindings.provider_id
               AND providers.binding_generation = $8
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
      )).changes === 1;
    },
    async delete(providerId: string): Promise<boolean> {
      return (await database.prepare(
        "DELETE FROM provider_account_bindings WHERE provider_id = $1",
      ).run(providerId)).changes === 1;
    },
  };

  const conversations = {
    async create(input: {
      id: string;
      projectId: string;
      runId?: string | null;
      actor: string;
      content: string;
    }): Promise<ConversationRecord> {
      (await database
        .prepare(
          `INSERT INTO conversations (id, project_id, run_id, actor, content)
           VALUES ($1, $2, $3, $4, $5)`,
        )
        .run(input.id, input.projectId, input.runId ?? null, input.actor, input.content));
      return (await findById<ConversationRecord>(database, "conversations", input.id))!;
    },
    async getById(id: string): Promise<ConversationRecord | null> {
      return (await findById(database, "conversations", id));
    },
    async list(): Promise<ConversationRecord[]> {
      return (await listRecords(database, "conversations"));
    },
  };

  const runs = {
    async create(input: {
      id: string;
      projectId: string;
      state: RunState;
      planVersion?: number;
      baselineCommit?: string | null;
    }): Promise<RunRecord> {
      (await database
        .prepare(
          `INSERT INTO runs (id, project_id, state, plan_version, baseline_commit)
           VALUES ($1, $2, $3, $4, $5)`,
        )
        .run(
          input.id,
          input.projectId,
          input.state,
          input.planVersion ?? 1,
          input.baselineCommit ?? null,
        ));
      return (await findById<RunRecord>(database, "runs", input.id))!;
    },
    async getById(id: string): Promise<RunRecord | null> {
      return (await findById(database, "runs", id));
    },
    async list(): Promise<RunRecord[]> {
      return (await listRecords(database, "runs"));
    },
  };

  const tasks = {
    async create(input: {
      id: string;
      runId: string;
      ownerAgentId?: string | null;
      title: string;
      state?: string;
      position?: number;
    }): Promise<TaskRecord> {
      (await database
        .prepare(
          `INSERT INTO tasks (id, run_id, owner_agent_id, title, state, position)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        )
        .run(
          input.id,
          input.runId,
          input.ownerAgentId ?? null,
          input.title,
          input.state ?? "queued",
          input.position ?? 0,
        ));
      return (await findById<TaskRecord>(database, "tasks", input.id))!;
    },
    async getById(id: string): Promise<TaskRecord | null> {
      return (await findById(database, "tasks", id));
    },
    async list(): Promise<TaskRecord[]> {
      return (await listRecords(database, "tasks"));
    },
    async listForRun(runId: string): Promise<TaskRecord[]> {
      return (await database
        .prepare("SELECT * FROM tasks WHERE run_id = $1 ORDER BY position ASC, id ASC")
        .all(runId))
        .map((row) => mapRow<TaskRecord>(row));
    },
  };

  const taskDependencies = {
    async set(taskId: string, dependsOnTaskIds: readonly string[]): Promise<void> {
      const insert = database.prepare(
        "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)",
      );
      await withTransaction(database, async () => {
        (await database.prepare("DELETE FROM task_dependencies WHERE task_id = $1").run(taskId));
        for (const dependencyId of dependsOnTaskIds) {
          (await insert.run(taskId, dependencyId));
        }
      });
    },
    async listForTask(taskId: string): Promise<TaskDependencyRecord[]> {
      return (await database
        .prepare(
          "SELECT task_id, depends_on_task_id FROM task_dependencies WHERE task_id = $1 ORDER BY depends_on_task_id",
        )
        .all(taskId))
        .map((row) => mapRow<TaskDependencyRecord>(row));
    },
  };

  const approvals = {
    async create(input: {
      id: string;
      runId: string;
      payloadFingerprint: string;
      decision: ApprovalRecord["decision"];
      planVersion?: number;
      baselineCommit?: string | null;
      scopeJson?: string;
    }): Promise<ApprovalRecord> {
      (await database
        .prepare(
          `INSERT INTO approvals (
             id, run_id, payload_fingerprint, decision, plan_version,
             baseline_commit, scope_json
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        )
        .run(
          input.id,
          input.runId,
          input.payloadFingerprint,
          input.decision,
          input.planVersion ?? 1,
          input.baselineCommit ?? null,
          input.scopeJson ?? "{}",
        ));
      return (await findById<ApprovalRecord>(database, "approvals", input.id))!;
    },
    async getById(id: string): Promise<ApprovalRecord | null> {
      return (await findById(database, "approvals", id));
    },
    async listForRun(runId: string): Promise<ApprovalRecord[]> {
      return (await database
        .prepare("SELECT * FROM approvals WHERE run_id = $1 ORDER BY created_at DESC, id DESC")
        .all(runId))
        .map((row) => mapRow<ApprovalRecord>(row));
    },
    async updateDecision(id: string, decision: ApprovalRecord["decision"]): Promise<boolean> {
      return (
        (await database
          .prepare("UPDATE approvals SET decision = $1 WHERE id = $2 AND decision = 'pending'")
          .run(decision, id)).changes === 1
      );
    },
    async list(): Promise<ApprovalRecord[]> {
      return (await listRecords(database, "approvals"));
    },
  };

  const leases = {
    async acquire(input: {
      workerId: string;
      runId: string;
      expiresAt: string;
      now: string;
    }): Promise<boolean> {
      const result = (await database
        .prepare(
          `INSERT INTO leases (singleton_id, worker_id, run_id, expires_at)
           VALUES ('global', $1, $2, $3)
           ON CONFLICT(singleton_id) DO UPDATE SET
             worker_id = excluded.worker_id,
             run_id = excluded.run_id,
             expires_at = excluded.expires_at
           WHERE leases.expires_at <= $4`,
        )
        .run(input.workerId, input.runId, input.expiresAt, input.now));
      return result.changes === 1;
    },
    async get(): Promise<LeaseRecord | null> {
      const row = (await database
        .prepare(
          "SELECT worker_id, run_id, expires_at FROM leases WHERE singleton_id = 'global'",
        )
        .get());
      return row === undefined ? null : mapRow<LeaseRecord>(row);
    },
    async release(workerId: string): Promise<boolean> {
      return (
        (await database
          .prepare("DELETE FROM leases WHERE singleton_id = 'global' AND worker_id = $1")
          .run(workerId)).changes === 1
      );
    },
  };

  const events = {
    async append<TPayload>(input: {
      runId: string;
      eventType: string;
      payload: TPayload;
    }): Promise<EventRecord<TPayload>> {
      const payloadJson = JSON.stringify(input.payload);
      if (payloadJson === undefined) {
        throw new Error("Event payload must be JSON serializable");
      }
      const row = await database
        .prepare(
          "INSERT INTO events (run_id, event_type, payload_json) VALUES ($1, $2, $3) RETURNING *",
        )
        .get(input.runId, input.eventType, payloadJson);
      const record = mapRow<Omit<EventRecord<TPayload>, "payload"> & { payloadJson: string }>(row);
      const { payloadJson: storedPayload, ...event } = record;
      return { ...event, payload: JSON.parse(storedPayload) as TPayload };
    },
    async listAfter<TPayload = unknown>(
      runId: string,
      lastEventId: number,
      limit = 100,
    ): Promise<EventRecord<TPayload>[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("Event page size must be between 1 and 1000");
      }
      return (await database
        .prepare(
          `SELECT * FROM events WHERE run_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
        )
        .all(runId, lastEventId, limit))
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
    async create(input: {
      id: string;
      runId: string;
      taskId?: string | null;
      status: VerificationStatus;
      details?: string;
    }): Promise<QaResultRecord> {
      (await database
        .prepare(
          `INSERT INTO qa_results (id, run_id, task_id, status, details)
           VALUES ($1, $2, $3, $4, $5)`,
        )
        .run(input.id, input.runId, input.taskId ?? null, input.status, input.details ?? ""));
      return (await findById<QaResultRecord>(database, "qa_results", input.id))!;
    },
    async getById(id: string): Promise<QaResultRecord | null> {
      return (await findById(database, "qa_results", id));
    },
    async list(): Promise<QaResultRecord[]> {
      return (await listRecords(database, "qa_results"));
    },
  };

  const artifacts = {
    async create(input: {
      id: string;
      runId: string;
      kind: string;
      filePath: string;
      sizeBytes: number;
    }): Promise<ArtifactRecord> {
      (await database
        .prepare(
          `INSERT INTO artifacts (id, run_id, kind, file_path, size_bytes)
           VALUES ($1, $2, $3, $4, $5)`,
        )
        .run(input.id, input.runId, input.kind, input.filePath, input.sizeBytes));
      return (await findById<ArtifactRecord>(database, "artifacts", input.id))!;
    },
    async getById(id: string): Promise<ArtifactRecord | null> {
      return (await findById(database, "artifacts", id));
    },
    async list(): Promise<ArtifactRecord[]> {
      return (await listRecords(database, "artifacts"));
    },
  };

  async function getWorkspaceById(id: string): Promise<WorkspaceRecord | null> {
    const workspace = (await findById<
      Omit<WorkspaceRecord, "setupCommands" | "verificationCommands"> & {
        setupCommandsJson: string;
        verificationCommandsJson: string;
      }
    >(database, "run_workspaces", id));
    if (!workspace) return null;
    const { setupCommandsJson, verificationCommandsJson, ...record } = workspace;
    return {
      ...record,
      setupCommands: JSON.parse(setupCommandsJson) as string[],
      verificationCommands: JSON.parse(verificationCommandsJson) as string[],
    };
  }

  const workspaces = {
    async create(input: {
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
    }): Promise<WorkspaceRecord> {
      (await database
        .prepare(
          `INSERT INTO run_workspaces (
             id, run_id, project_id, source_path, workspace_path, baseline_path,
             baseline_commit, setup_commands_json, verification_commands_json, state
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
        ));
      return (await getWorkspaceById(input.id))!;
    },
    async getById(id: string): Promise<WorkspaceRecord | null> {
      return (await getWorkspaceById(id));
    },
    async getByRunId(runId: string): Promise<WorkspaceRecord | null> {
      const row = (await database
        .prepare("SELECT id FROM run_workspaces WHERE run_id = $1")
        .get(runId)) as { id: string } | undefined;
      return row ? (await getWorkspaceById(row.id)) : null;
    },
  };

  const checkpoints = {
    async create(input: {
      id: string;
      runId: string;
      taskId?: string | null;
      baselineCommit: string | null;
      snapshotPath: string;
      changedFilesJson: string;
    }): Promise<CheckpointRecord> {
      (await database
        .prepare(
          `INSERT INTO checkpoints (
             id, run_id, task_id, baseline_commit, snapshot_path, changed_files_json
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
        )
        .run(
          input.id,
          input.runId,
          input.taskId ?? null,
          input.baselineCommit,
          input.snapshotPath,
          input.changedFilesJson,
        ));
      return (await findById<CheckpointRecord>(database, "checkpoints", input.id))!;
    },
    async getById(id: string): Promise<CheckpointRecord | null> {
      return (await findById(database, "checkpoints", id));
    },
    async listForRun(runId: string): Promise<CheckpointRecord[]> {
      return (await database
        .prepare("SELECT * FROM checkpoints WHERE run_id = $1 ORDER BY created_at DESC, id DESC")
        .all(runId))
        .map((row) => mapRow<CheckpointRecord>(row));
    },
  };

  const runPlans = {
    async create(input: Omit<RunPlanRecord, "createdAt">): Promise<RunPlanRecord> {
      (await database
        .prepare(
          `INSERT INTO run_plans (
             run_id, plan_version, goal, acceptance_criteria_json, setup_commands_json,
             verification_commands_json, allowed_tools_json, approval_id, approval_fingerprint
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
        ));
      return (await this.getByRunId(input.runId))!;
    },
    async getByRunId(runId: string): Promise<RunPlanRecord | null> {
      const row = (await database.prepare("SELECT * FROM run_plans WHERE run_id = $1").get(runId));
      return row === undefined ? null : mapRow<RunPlanRecord>(row);
    },
  };

  const qaRounds = {
    async create(input: Omit<QaRoundRecord, "createdAt">): Promise<QaRoundRecord> {
      (await database
        .prepare(
          `INSERT INTO qa_rounds (id, run_id, round_number, status, details)
           VALUES ($1, $2, $3, $4, $5)`,
        )
        .run(input.id, input.runId, input.roundNumber, input.status, input.details));
      return (await findById<QaRoundRecord>(database, "qa_rounds", input.id))!;
    },
    async listForRun(runId: string): Promise<QaRoundRecord[]> {
      return (await database
        .prepare("SELECT * FROM qa_rounds WHERE run_id = $1 ORDER BY round_number ASC")
        .all(runId))
        .map((row) => mapRow<QaRoundRecord>(row));
    },
  };

  const usageRecords = {
    async create(input: {
      id: string;
      runId: string;
      providerId?: string | null;
      requestCount?: number;
      toolCallCount?: number;
      inputTokens?: number;
      outputTokens?: number;
      estimatedCostMicrounits?: number | null;
      usageState?: UsageRecord["usageState"];
    }): Promise<UsageRecord> {
      (await database
        .prepare(
          `INSERT INTO usage_records (
             id, run_id, provider_id, request_count, tool_call_count,
             input_tokens, output_tokens, estimated_cost_microunits, usage_state
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
        ));
      return (await findById<UsageRecord>(database, "usage_records", input.id))!;
    },
    async getById(id: string): Promise<UsageRecord | null> {
      return (await findById(database, "usage_records", id));
    },
    async list(): Promise<UsageRecord[]> {
      return (await listRecords(database, "usage_records"));
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
