import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_orchestrator_schema",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_url TEXT,
        baseline_ref TEXT,
        baseline_commit TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('not_configured', 'needs_login', 'ready', 'rate_limited', 'unavailable')),
        model TEXT,
        auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api_key', 'subscription_cli', 'none')),
        secret_reference TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        actor TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('draft', 'awaiting_approval', 'queued', 'running', 'awaiting_review', 'blocked', 'interrupted', 'failed', 'done', 'cancelled')),
        plan_version INTEGER NOT NULL DEFAULT 1 CHECK (plan_version > 0),
        baseline_commit TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_task_id),
        CHECK (task_id <> depends_on_task_id)
      );

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        payload_fingerprint TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE leases (
        singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'global'),
        worker_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE qa_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('verified', 'failed', 'not-run')),
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE usage_records (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
        request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
        tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (tool_call_count >= 0),
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        estimated_cost_microunits INTEGER CHECK (estimated_cost_microunits IS NULL OR estimated_cost_microunits >= 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX conversations_project_created_idx ON conversations(project_id, created_at);
      CREATE INDEX runs_project_created_idx ON runs(project_id, created_at);
      CREATE INDEX tasks_run_position_idx ON tasks(run_id, position);
      CREATE INDEX events_run_id_idx ON events(run_id, id);
      CREATE INDEX qa_results_run_created_idx ON qa_results(run_id, created_at);
      CREATE INDEX artifacts_run_created_idx ON artifacts(run_id, created_at);
      CREATE INDEX usage_records_run_created_idx ON usage_records(run_id, created_at);
    `,
  },
  {
    version: 2,
    name: "approval_scope_binding",
    sql: `
      ALTER TABLE approvals ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 1 CHECK (plan_version > 0);
      ALTER TABLE approvals ADD COLUMN baseline_commit TEXT;
      ALTER TABLE approvals ADD COLUMN scope_json TEXT NOT NULL DEFAULT '{}';
      CREATE INDEX approvals_run_created_idx ON approvals(run_id, created_at);
    `,
  },
  {
    version: 3,
    name: "run_workspaces_and_checkpoints",
    sql: `
      CREATE TABLE run_workspaces (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_path TEXT,
        workspace_path TEXT NOT NULL,
        baseline_path TEXT NOT NULL,
        baseline_commit TEXT,
        setup_commands_json TEXT NOT NULL,
        verification_commands_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ready', 'blocked', 'closed')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        baseline_commit TEXT,
        snapshot_path TEXT NOT NULL,
        changed_files_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX checkpoints_run_created_idx ON checkpoints(run_id, created_at);
    `,
  },
  {
    version: 4,
    name: "finite_run_usage_budgets",
    sql: `
      CREATE TABLE run_usage_budgets (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        max_requests INTEGER NOT NULL CHECK (max_requests > 0),
        max_tool_calls INTEGER NOT NULL CHECK (max_tool_calls >= 0),
        max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    version: 5,
    name: "usage_reservation_state",
    sql: `
      ALTER TABLE usage_records
      ADD COLUMN usage_state TEXT NOT NULL DEFAULT 'known' CHECK (usage_state IN ('known', 'reserved', 'unknown'));
    `,
  },
  {
    version: 6,
    name: "run_plans",
    sql: `
      CREATE TABLE run_plans (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        plan_version INTEGER NOT NULL CHECK (plan_version > 0),
        goal TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        setup_commands_json TEXT NOT NULL,
        verification_commands_json TEXT NOT NULL,
        allowed_tools_json TEXT NOT NULL,
        approval_id TEXT NOT NULL REFERENCES approvals(id),
        approval_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `,
  },
  {
    version: 7,
    name: "qa_rounds",
    sql: `
      CREATE TABLE qa_rounds (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        round_number INTEGER NOT NULL CHECK (round_number > 0),
        status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
        details TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (run_id, round_number)
      );
      CREATE INDEX qa_rounds_run_number_idx ON qa_rounds(run_id, round_number);
    `,
  },
  {
    version: 8,
    name: "subscription_provider_bindings",
    sql: `
      ALTER TABLE providers
      ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('deepseek', 'antigravity', 'codex', 'claude'));
      UPDATE providers
      SET kind = 'deepseek'
      WHERE lower(name) = 'deepseek' AND auth_mode = 'api_key';
      CREATE UNIQUE INDEX subscription_provider_kind_unique
      ON providers(kind)
      WHERE auth_mode = 'subscription_cli' AND kind IS NOT NULL;
      CREATE TABLE provider_account_bindings (
        provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
        binding_id TEXT NOT NULL UNIQUE
          CHECK (length(binding_id) BETWEEN 1 AND 64)
          CHECK (binding_id NOT GLOB '*[^a-z0-9_-]*')
          CHECK (substr(binding_id, 1, 1) GLOB '[a-z0-9]'),
        state TEXT NOT NULL CHECK (state IN (
          'not_installed', 'needs_login', 'connected', 'ready',
          'rate_limited', 'unavailable', 'unsupported'
        )),
        reason TEXT CHECK (reason IS NULL OR length(reason) <= 256),
        checked_at TEXT CHECK (checked_at IS NULL OR length(checked_at) <= 64),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
      );
    `,
  },
];

export function migrateDatabase(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const appliedStatement = database.prepare(
    "SELECT version FROM schema_migrations WHERE version = ?",
  );
  const insertStatement = database.prepare(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  for (const migration of migrations) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const alreadyApplied = appliedStatement.get(migration.version);
      if (!alreadyApplied) {
        database.exec(migration.sql);
        insertStatement.run(migration.version, migration.name);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
