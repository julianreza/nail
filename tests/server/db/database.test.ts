import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRepositories,
  openDatabase,
  withTransaction,
} from "../../../lib/server/db/database";

const temporaryDirectories: string[] = [];

function createDatabaseIdentity(): string {
  const directory = mkdtempSync(join(tmpdir(), "nail-postgres-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "orchestrator-database");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("PostgreSQL persistence", () => {
  it("migrates an empty PostgreSQL database with foreign keys", async () => {
    const path = createDatabaseIdentity();
    const db = (await openDatabase(path));
    try {
      expect(await db.prepare("SELECT version() AS version").get()).toMatchObject({ version: expect.stringContaining("PostgreSQL") });
      expect(
        (await db.prepare(
          "SELECT version FROM schema_migrations ORDER BY version",
        ).all()),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
      ]);
      expect(
        (await db
          .prepare(
            "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' ORDER BY tablename",
          )
          .all()),
      ).toHaveLength(19);
    } finally {
      (await db.close());
    }
  });

  it("rolls back a multi-repository write when a foreign key fails", async () => {
    const db = (await openDatabase(createDatabaseIdentity()));
    const repositories = createRepositories(db);
    try {
      await expect(async () =>
        (await withTransaction(db, async () => {
          (await repositories.projects.create({ id: "project-1", name: "Nail" }));
          (await repositories.agents.create({
            id: "agent-1",
            projectId: "missing-project",
            name: "Engineer",
            role: "engineer",
            instructions: "",
          }));
        })),
      ).rejects.toThrow();
      expect((await repositories.projects.getById("project-1"))).toBeNull();
    } finally {
      (await db.close());
    }
  });

  it("persists projects and produces increasing event IDs across reopen", async () => {
    const path = createDatabaseIdentity();
    let db = (await openDatabase(path));
    let repositories = createRepositories(db);
    (await repositories.projects.create({ id: "project-1", name: "Nail" }));
    (await repositories.runs.create({
      id: "run-1",
      projectId: "project-1",
      state: "draft",
      planVersion: 1,
      baselineCommit: "base-1",
    }));
    const firstEvent = (await repositories.events.append({
      runId: "run-1",
      eventType: "run.created",
      payload: { state: "draft" },
    }));
    (await db.close());

    db = (await openDatabase(path));
    repositories = createRepositories(db);
    try {
      expect((await repositories.projects.getById("project-1"))?.name).toBe("Nail");
      const secondEvent = (await repositories.events.append({
        runId: "run-1",
        eventType: "task.added",
        payload: { taskId: "task-1" },
      }));
      expect(secondEvent.id).toBeGreaterThan(firstEvent.id);
      expect((await repositories.events.listAfter("run-1", firstEvent.id))).toEqual([
        expect.objectContaining({
          id: secondEvent.id,
          eventType: "task.added",
          payload: { taskId: "task-1" },
        }),
      ]);
    } finally {
      (await db.close());
    }
  });
});
