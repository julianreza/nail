import { type Database, withTransaction } from "./database";

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
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );

      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('not_configured', 'needs_login', 'ready', 'rate_limited', 'unavailable')),
        model TEXT,
        auth_mode TEXT NOT NULL CHECK (auth_mode IN ('api_key', 'subscription_cli', 'none')),
        secret_reference TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('draft', 'awaiting_approval', 'queued', 'running', 'awaiting_review', 'blocked', 'interrupted', 'failed', 'done', 'cancelled')),
        plan_version INTEGER NOT NULL DEFAULT 1 CHECK (plan_version > 0),
        baseline_commit TEXT,
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
        updated_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        actor TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        owner_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );

      CREATE TABLE leases (
        singleton_id TEXT PRIMARY KEY CHECK (singleton_id = 'global'),
        worker_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE events (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );

      CREATE TABLE qa_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('verified', 'failed', 'not-run')),
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );

      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        baseline_commit TEXT,
        snapshot_path TEXT NOT NULL,
        changed_files_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
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
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
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
          CHECK (binding_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
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
  {
    version: 9,
    name: "subscription_binding_generation",
    sql: `
      ALTER TABLE providers
      ADD COLUMN binding_generation INTEGER NOT NULL DEFAULT 0 CHECK (binding_generation >= 0);
    `,
  },
  {
    version: 10,
    name: "subscription_binding_generation_cas",
    sql: `
      ALTER TABLE provider_account_bindings
      ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);
    `,
  },
  {
    version: 11,
    name: "postgres_constraints_and_server_only_access",
    sql: `
      ALTER TABLE tasks ADD CONSTRAINT task_state_valid
        CHECK (state IN ('queued', 'running', 'done', 'failed', 'blocked', 'cancelled'));
      CREATE UNIQUE INDEX one_running_task_per_run ON tasks(run_id) WHERE state = 'running';
      ALTER TABLE providers ADD CONSTRAINT subscription_secret_free
        CHECK (auth_mode <> 'subscription_cli' OR
          (kind IS NOT NULL AND kind <> 'deepseek' AND secret_reference IS NULL));
      ALTER TABLE providers ADD CONSTRAINT capabilities_array
        CHECK (jsonb_typeof(capabilities_json::jsonb) = 'array');
      ALTER TABLE approvals ADD CONSTRAINT scope_object CHECK (jsonb_typeof(scope_json::jsonb) = 'object');
      ALTER TABLE events ADD CONSTRAINT payload_valid CHECK (payload_json::jsonb IS NOT NULL);
      ALTER TABLE checkpoints ADD CONSTRAINT changed_files_array CHECK (jsonb_typeof(changed_files_json::jsonb) = 'array');
      ALTER TABLE run_plans
        ADD CONSTRAINT criteria_array CHECK (jsonb_typeof(acceptance_criteria_json::jsonb) = 'array'),
        ADD CONSTRAINT setup_array CHECK (jsonb_typeof(setup_commands_json::jsonb) = 'array'),
        ADD CONSTRAINT verification_array CHECK (jsonb_typeof(verification_commands_json::jsonb) = 'array'),
        ADD CONSTRAINT tools_array CHECK (jsonb_typeof(allowed_tools_json::jsonb) = 'array');
      ALTER TABLE run_workspaces
        ADD CONSTRAINT setup_array CHECK (jsonb_typeof(setup_commands_json::jsonb) = 'array'),
        ADD CONSTRAINT verification_array CHECK (jsonb_typeof(verification_commands_json::jsonb) = 'array');
      ALTER TABLE artifacts ALTER COLUMN size_bytes TYPE BIGINT;
      ALTER TABLE usage_records ALTER COLUMN estimated_cost_microunits TYPE BIGINT;
      ALTER TABLE events ALTER COLUMN id TYPE BIGINT;
      ALTER TABLE runs ALTER COLUMN updated_at DROP DEFAULT;
      ALTER TABLE runs ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;
      ALTER TABLE runs ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE leases ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::timestamptz;
      ALTER TABLE schema_migrations ALTER COLUMN applied_at DROP DEFAULT;
      ALTER TABLE schema_migrations ALTER COLUMN applied_at TYPE TIMESTAMPTZ USING applied_at::timestamptz;
      ALTER TABLE schema_migrations ALTER COLUMN applied_at SET DEFAULT CURRENT_TIMESTAMP;

      DO $$
      DECLARE nail_table TEXT; role_name TEXT;
      BEGIN
        FOREACH nail_table IN ARRAY ARRAY[
          'projects', 'providers', 'agents', 'runs', 'conversations', 'tasks',
          'task_dependencies', 'approvals', 'leases', 'events', 'qa_results',
          'artifacts', 'usage_records', 'run_workspaces', 'checkpoints',
          'run_usage_budgets', 'run_plans', 'qa_rounds', 'provider_account_bindings',
          'schema_migrations'
        ] LOOP
          IF EXISTS (SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = current_schema() AND c.table_name = nail_table AND c.column_name = 'created_at') THEN
            EXECUTE format('ALTER TABLE %I ALTER COLUMN created_at DROP DEFAULT', nail_table);
            EXECUTE format('ALTER TABLE %I ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz', nail_table);
            EXECUTE format('ALTER TABLE %I ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP', nail_table);
          END IF;
          -- Supabase's default grants must not expose owner data via PostgREST.
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', nail_table);
          EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', nail_table);
          FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
              EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', nail_table, role_name);
            END IF;
          END LOOP;
        END LOOP;
      END $$;
    `,
  },
  {
    version: 12,
    name: "agent_configuration_and_revision",
    sql: `
      ALTER TABLE agents
        ADD COLUMN model TEXT,
        ADD COLUMN skill_ids_json TEXT NOT NULL DEFAULT '[]',
        ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
      UPDATE agents
      SET model = providers.model
      FROM providers
      WHERE agents.provider_id = providers.id;
      UPDATE agents SET updated_at = created_at;
      ALTER TABLE agents
        ADD CONSTRAINT agent_skill_ids_array
          CHECK (jsonb_typeof(skill_ids_json::jsonb) = 'array'
            AND jsonb_array_length(skill_ids_json::jsonb) <= 10),
        ADD CONSTRAINT agent_model_format
          CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

      DO $$
      DECLARE owner_agent_attnum SMALLINT; owner_agent_fk TEXT;
      BEGIN
        SELECT attnum INTO owner_agent_attnum
        FROM pg_attribute
        WHERE attrelid = 'tasks'::regclass AND attname = 'owner_agent_id' AND NOT attisdropped;
        SELECT conname INTO owner_agent_fk
        FROM pg_constraint
        WHERE conrelid = 'tasks'::regclass AND contype = 'f'
          AND conkey = ARRAY[owner_agent_attnum]::SMALLINT[];
        IF owner_agent_fk IS NULL THEN
          RAISE EXCEPTION 'Expected tasks owner_agent_id foreign key';
        END IF;
        EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', owner_agent_fk);
        ALTER TABLE tasks ADD CONSTRAINT tasks_owner_agent_id_fkey
          FOREIGN KEY (owner_agent_id) REFERENCES agents(id) ON DELETE RESTRICT;
      END $$;
    `,
  },
];

export async function migrateDatabase(database: Database): Promise<void> {
  await withTransaction(database, async () => {
    await database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const appliedStatement = database.prepare(
      "SELECT version FROM schema_migrations WHERE version = $1",
    );
    const insertStatement = database.prepare(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
    );

    for (const migration of migrations) {
      const alreadyApplied = await appliedStatement.get(migration.version);
      if (!alreadyApplied) {
        await database.exec(migration.sql);
        await insertStatement.run(migration.version, migration.name);
      }
    }
  });
}
