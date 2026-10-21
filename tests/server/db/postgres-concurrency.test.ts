import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositories, databasePoolConfig, openDatabase, withTransaction, type Database } from "../../../lib/server/db/database";
import { createApprovalService } from "../../../lib/server/runs/approval-service";
import { claimNextJob } from "../../../lib/server/queue/queue-service";
import { setTaskState } from "../../../lib/server/orchestration/plan-service";
import { configureRunUsageBudget, reserveProviderRequest } from "../../../lib/server/providers/usage-budget";

const connections: Database[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map((db) => db.close())); });
async function pair() {
  const identity = `postgres-concurrency-${randomUUID()}`;
  const databases = await Promise.all([openDatabase(identity), openDatabase(identity)]);
  connections.push(...databases);
  return databases;
}

describe("verified database transport configuration", () => {
  it("requires a PostgreSQL URL and verifies certificates even for sslmode=require", () => {
    expect(() => databasePoolConfig("/not/a/database/url")).toThrow(/PostgreSQL/);
    expect(databasePoolConfig("postgresql://owner:placeholder@db.example.test/postgres?sslmode=require").ssl).toMatchObject({ rejectUnauthorized: true });
    const config = databasePoolConfig("postgresql://owner:placeholder@db.example.test/postgres?ssl=0&sslmode=require&host=127.0.0.1");
    expect(config.host).toBe("db.example.test");
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(databasePoolConfig("postgresql://owner:placeholder@127.0.0.1/postgres").ssl).toBe(false);
  });
});

describe.skipIf(!process.env.NAIL_TEST_DATABASE_URL)("real PostgreSQL concurrency and constraints", () => {
  it("reserves one backend for async transactions and isolates overlapping rollback", async () => {
    const [db] = await pair();
    const repositories = createRepositories(db);
    const rolledBack = withTransaction(db, async () => {
      const before = await db.prepare("SELECT pg_backend_pid() AS pid").get();
      await repositories.projects.create({ id: "rollback", name: "Rollback" });
      await db.prepare("SELECT pg_sleep(0.03)").get();
      expect(await db.prepare("SELECT pg_backend_pid() AS pid").get()).toEqual(before);
      throw new Error("rollback");
    });
    const committed = withTransaction(db, async () => {
      await repositories.projects.create({ id: "commit", name: "Commit" });
    });
    await expect(rolledBack).rejects.toThrow("rollback");
    await committed;
    expect(await repositories.projects.getById("rollback")).toBeNull();
    expect(await repositories.projects.getById("commit")).toMatchObject({ name: "Commit" });
  });

  it("serializes duplicate approval submissions, competing decisions, and queue claims across pools", async () => {
    const [first, second] = await pair();
    const repos = createRepositories(first);
    await repos.projects.create({ id: "p", name: "Project" });
    await repos.runs.create({ id: "r", projectId: "p", state: "draft" });
    const scope = { planVersion: 1, baselineCommit: null, setupCommands: [], verificationCommands: [], permissions: [], costLimitMicrounits: 100 };
    const services = [first, second].map((db) => createApprovalService(db, { allowedPermissions: [] }));
    const approvals = await Promise.all(services.map((service) => service.submitForApproval("r", scope)));
    expect(approvals[0].id).toBe(approvals[1].id);
    const decisions = await Promise.allSettled(services.map((service) => service.decide(approvals[0].id, { decision: "approved", expectedFingerprint: approvals[0].payloadFingerprint })));
    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    const now = new Date().toISOString();
    const claims = await Promise.all([first, second].map((db, index) => claimNextJob(db, { workerId: `worker-${index}`, now, leaseDurationMs: 30_000 })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await repos.runs.getById("r")).toMatchObject({ state: "running" });
    expect((await repos.events.listAfter("r", 0)).filter((event) => event.eventType === "approval.decided")).toHaveLength(1);
    await repos.tasks.create({ id: "first", runId: "r", title: "First", position: 0 });
    await repos.tasks.create({ id: "second", runId: "r", title: "Second", position: 1 });
    const taskStarts = await Promise.allSettled([
      setTaskState(first, "first", "running", "worker"),
      setTaskState(second, "second", "running", "worker"),
    ]);
    expect(taskStarts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await repos.tasks.listForRun("r")).filter((task) => task.state === "running")).toHaveLength(1);
  });

  it("does not overspend a finite budget under concurrent provider reservations", async () => {
    const [first, second] = await pair();
    const repos = createRepositories(first);
    await repos.projects.create({ id: "p", name: "Project" });
    await repos.runs.create({ id: "r", projectId: "p", state: "draft" });
    await repos.providers.create({ id: "provider", name: "Provider", authMode: "none", status: "not_configured" });
    await configureRunUsageBudget(first, { runId: "r", maxRequests: 1, maxToolCalls: 0, maxOutputTokens: 10 });
    const outcomes = await Promise.allSettled([first, second].map((db) => reserveProviderRequest(db, { runId: "r", providerId: "provider", maxOutputTokens: 10 })));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await repos.usageRecords.list()).toHaveLength(1);
  });

  it("enforces native timestamp, task, JSON and secret-free provider constraints", async () => {
    const [db] = await pair();
    const repos = createRepositories(db);
    await repos.projects.create({ id: "p", name: "Project" });
    await repos.runs.create({ id: "r", projectId: "p", state: "draft" });
    await expect(repos.tasks.create({ id: "bad", runId: "r", title: "Invalid", state: "unknown" })).rejects.toThrow();
    await expect(db.prepare("UPDATE projects SET created_at = 'not-a-timestamp' WHERE id = $1").run("p")).rejects.toThrow();
    await expect(db.prepare("INSERT INTO providers (id, name, status, auth_mode, kind, secret_reference) VALUES ('bad', 'Bad', 'ready', 'subscription_cli', 'codex', 'forbidden')").run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO events (run_id, event_type, payload_json) VALUES ('r', 'invalid', 'not-json')").run()).rejects.toThrow();
    expect(await db.prepare("SELECT relrowsecurity FROM pg_class WHERE oid = 'projects'::regclass").get()).toEqual({ relrowsecurity: true });
    const grants = await db.prepare("SELECT rolname, has_table_privilege(rolname, 'projects', 'SELECT') AS allowed FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')").all();
    expect(grants.every((grant) => grant.allowed === false)).toBe(true);
  });

  it("aborts an enclosing transaction even if a nested failure is caught", async () => {
    const [db] = await pair();
    const repos = createRepositories(db);
    await expect(withTransaction(db, async () => {
      await repos.projects.create({ id: "nested", name: "Nested" });
      try {
        await withTransaction(db, async () => { throw new Error("nested failure"); });
      } catch { /* Must not turn a partial write into a commit. */ }
    })).rejects.toThrow("nested failure");
    expect(await repos.projects.getById("nested")).toBeNull();
  });
});
