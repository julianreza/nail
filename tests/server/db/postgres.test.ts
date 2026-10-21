import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, withTransaction, createRepositories } from "../../../lib/server/db/database";

const url = process.env.NAIL_TEST_DATABASE_URL;
const databases: Awaited<ReturnType<typeof openDatabase>>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe.skipIf(!url)("PostgreSQL driver regression", () => {
  it("uses PostgreSQL, preserves column case and rolls back asynchronous writes", async () => {
    const db = await openDatabase(url!);
    databases.push(db);
    expect(await db.prepare("SELECT version() AS version").get()).toMatchObject({ version: expect.stringContaining("PostgreSQL") });
    expect(await db.prepare('SELECT 7 AS "maxOutputTokens"').get()).toEqual({ maxOutputTokens: 7 });
    const repositories = createRepositories(db);
    await expect(withTransaction(db, async () => {
      await repositories.projects.create({ id: "rollback-postgres", name: "Rollback" });
      await Promise.resolve();
      throw new Error("rollback regression");
    })).rejects.toThrow("rollback regression");
    expect(await repositories.projects.getById("rollback-postgres")).toBeNull();
  });

  it("runs concurrent migrations and allows only one lease winner", async () => {
    const [first, second] = await Promise.all([openDatabase(url!), openDatabase(url!)]);
    databases.push(first, second);
    const repositories = createRepositories(first);
    await first.prepare("DELETE FROM projects WHERE id = $1").run("concurrent-postgres");
    await repositories.projects.create({ id: "concurrent-postgres", name: "Concurrent" });
    await repositories.runs.create({ id: "concurrent-postgres", projectId: "concurrent-postgres", state: "queued" });
    const input = { runId: "concurrent-postgres", now: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:01:00.000Z" };
    const outcomes = await Promise.all([
      repositories.leases.acquire({ ...input, workerId: "first" }),
      createRepositories(second).leases.acquire({ ...input, workerId: "second" }),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await first.prepare("DELETE FROM projects WHERE id = $1").run("concurrent-postgres");
  });
});
