import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createRepositories, openDatabase, Database, databasePoolConfig } from "../../../lib/server/db/database";
import { migrateDatabase } from "../../../lib/server/db/migrations";

it("persists explicit agent model and skills and preserves old create callers", async () => {
  const identity = `agent-repository-${randomUUID()}`;
  let db = await openDatabase(identity);
  try {
    const repos = createRepositories(db);
    await repos.providers.create({
      id: "codex-provider",
      name: "Codex Subscription",
      kind: "codex",
      authMode: "subscription_cli",
      status: "unavailable",
      model: "configured-model",
    });
    const created = await repos.agents.create({
      id: "agent-configured",
      name: "PM",
      role: "pm",
      providerId: "codex-provider",
      model: "configured-model",
      skillIds: ["planning"],
    });
    const legacy = await repos.agents.create({
      id: "agent-legacy",
      name: "Legacy",
      role: "engineer",
    });
    await db.close();

    db = await openDatabase(identity);
    const reopened = createRepositories(db);
    expect(await reopened.agents.getById("agent-configured")).toMatchObject({
      id: "agent-configured",
      model: "configured-model",
      skillIds: ["planning"],
      revision: 1,
      createdAt: created.createdAt,
      updatedAt: created.createdAt,
    });
    expect(await reopened.agents.getById("agent-legacy")).toMatchObject({
      id: "agent-legacy",
      model: null,
      skillIds: [],
      revision: 1,
      createdAt: legacy.createdAt,
      updatedAt: legacy.createdAt,
    });
    expect((await reopened.agents.list()).map(({ id }) => id)).toEqual([
      "agent-configured",
      "agent-legacy",
    ]);
  } finally {
    await db.close();
  }
});

it("backfills existing agent configuration and restricts deleting referenced agents", async () => {
  const baseUrl = process.env.NAIL_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("This migration regression requires the disposable PostgreSQL runner");
  const schema = `agent_migration_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool(databasePoolConfig(baseUrl));
  let migrated: Database | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    const scopedUrl = new URL(baseUrl);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    migrated = new Database(new Pool(databasePoolConfig(scopedUrl.toString())));
    await migrated.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO schema_migrations (version, name)
      SELECT version, 'legacy' FROM generate_series(1, 11) AS version;
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      CREATE TABLE providers (id TEXT PRIMARY KEY, model TEXT);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
        name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        owner_agent_id TEXT CONSTRAINT tasks_owner_agent_id_fkey
          REFERENCES agents(id) ON DELETE SET NULL
      );
      INSERT INTO projects (id) VALUES ('legacy-project');
      INSERT INTO providers (id, model) VALUES ('legacy-provider', 'old-configured-model');
      INSERT INTO agents (id, project_id, provider_id, name, role, created_at)
      VALUES ('legacy-agent', 'legacy-project', 'legacy-provider', 'Legacy PM', 'pm', '2024-01-02T03:04:05.000Z');
      INSERT INTO tasks (id, owner_agent_id) VALUES ('historical-task', 'legacy-agent');
    `);

    await migrateDatabase(migrated);
    expect(await migrated.prepare(
      `SELECT model, skill_ids_json, revision, created_at, updated_at
       FROM agents WHERE id = $1`,
    ).get("legacy-agent")).toEqual({
      model: "old-configured-model",
      skill_ids_json: "[]",
      revision: 1,
      created_at: "2024-01-02T03:04:05.000Z",
      updated_at: "2024-01-02T03:04:05.000Z",
    });
    await expect(migrated.prepare("DELETE FROM agents WHERE id = $1").run("legacy-agent")).rejects.toThrow();
    expect(await migrated.prepare("SELECT owner_agent_id FROM tasks WHERE id = $1").get("historical-task"))
      .toEqual({ owner_agent_id: "legacy-agent" });
  } finally {
    await migrated?.close();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  }
});
