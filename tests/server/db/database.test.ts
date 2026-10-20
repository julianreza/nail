import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRepositories,
  openDatabase,
  withTransaction,
} from "../../../lib/server/db/database";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "nail-sqlite-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "orchestrator.sqlite");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("SQLite persistence", () => {
  it("migrates an empty database and enables WAL and foreign keys", () => {
    const path = createDatabasePath();
    const db = openDatabase(path);
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "wal",
      });
      expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({
        foreign_keys: 1,
      });
      expect(
        db.prepare(
          "SELECT version FROM schema_migrations ORDER BY version",
        ).all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
      ]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'agents', 'providers', 'conversations', 'runs', 'tasks', 'task_dependencies', 'approvals', 'leases', 'events', 'qa_results', 'artifacts', 'usage_records', 'run_workspaces', 'checkpoints', 'run_usage_budgets', 'run_plans', 'qa_rounds', 'provider_account_bindings') ORDER BY name",
          )
          .all(),
      ).toHaveLength(19);
    } finally {
      db.close();
    }
  });

  it("rolls back a multi-repository write when a foreign key fails", () => {
    const db = openDatabase(createDatabasePath());
    const repositories = createRepositories(db);
    try {
      expect(() =>
        withTransaction(db, () => {
          repositories.projects.create({ id: "project-1", name: "Nail" });
          repositories.agents.create({
            id: "agent-1",
            projectId: "missing-project",
            name: "Engineer",
            role: "engineer",
            instructions: "",
          });
        }),
      ).toThrow();
      expect(repositories.projects.getById("project-1")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("persists projects and produces increasing event IDs across reopen", () => {
    const path = createDatabasePath();
    let db = openDatabase(path);
    let repositories = createRepositories(db);
    repositories.projects.create({ id: "project-1", name: "Nail" });
    repositories.runs.create({
      id: "run-1",
      projectId: "project-1",
      state: "draft",
      planVersion: 1,
      baselineCommit: "base-1",
    });
    const firstEvent = repositories.events.append({
      runId: "run-1",
      eventType: "run.created",
      payload: { state: "draft" },
    });
    db.close();

    db = openDatabase(path);
    repositories = createRepositories(db);
    try {
      expect(repositories.projects.getById("project-1")?.name).toBe("Nail");
      const secondEvent = repositories.events.append({
        runId: "run-1",
        eventType: "task.added",
        payload: { taskId: "task-1" },
      });
      expect(secondEvent.id).toBeGreaterThan(firstEvent.id);
      expect(repositories.events.listAfter("run-1", firstEvent.id)).toEqual([
        expect.objectContaining({
          id: secondEvent.id,
          eventType: "task.added",
          payload: { taskId: "task-1" },
        }),
      ]);
    } finally {
      db.close();
    }
  });
});
