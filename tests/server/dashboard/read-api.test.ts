import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthHandlers, hashOwnerPassword } from "../../../lib/server/auth/auth-service";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { createDashboardReadHandlers } from "../../../lib/server/dashboard/read-api";

const temporaryDirectories: string[] = [];

function createDatabaseIdentity(): string {
  const directory = mkdtempSync(join(tmpdir(), "nail-dashboard-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "orchestrator-database");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

async function createAuthenticatedHandlers(databaseUrl?: string) {
  const auth = createAuthHandlers({
    ownerPasswordHash: await hashOwnerPassword("correct horse battery", {
      salt: Buffer.alloc(16, 3),
    }),
    sessionSecret: Buffer.alloc(32, 4).toString("base64url"),
    appOrigin: "https://nail.example",
    secureCookies: true,
  });
  const login = await auth.login(
    new Request("https://nail.example/api/auth/login", {
      method: "POST",
      headers: {
        origin: "https://nail.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: "correct horse battery" }),
    }),
  );
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  return {
    handlers: createDashboardReadHandlers(auth, databaseUrl),
    request: (path: string) =>
      new Request(`https://nail.example${path}`, { headers: { cookie } }),
  };
}

describe("authenticated dashboard read APIs", () => {
  it("rejects unauthenticated requests before touching the database", async () => {
    const path = createDatabaseIdentity();
    const handlers = createDashboardReadHandlers(
      {
        protectedResource: async () =>
          Response.json({ error: "Unauthorized" }, { status: 401 }),
      },
      path,
    );
    const response = await handlers.overview(
      new Request("https://nail.example/api/overview"),
    );

    expect(response.status).toBe(401);
  });

  it("reports missing database configuration instead of fabricating counts", async () => {
    const { handlers, request } = await createAuthenticatedHandlers();
    const response = await handlers.overview(request("/api/overview"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Database is not configured" });
  });

  it("returns real zero counts and empty lists for a fresh database", async () => {
    const { handlers, request } = await createAuthenticatedHandlers(createDatabaseIdentity());
    const overview = await handlers.overview(request("/api/overview"));
    const projects = await handlers.projects(request("/api/projects"));

    expect(overview.status).toBe(200);
    expect(await overview.json()).toEqual({
      projectsCount: 0,
      agentsCount: 0,
      agents: [],
      activeRunsCount: 0,
      queuedRunsCount: 0,
      pendingApprovalsCount: 0,
    });
    expect(await projects.json()).toEqual([]);
  });

  it("returns counts and records from PostgreSQL without exposing provider secret references", async () => {
    const path = createDatabaseIdentity();
    const database = (await openDatabase(path));
    const repositories = createRepositories(database);
    (await repositories.projects.create({ id: "project-1", name: "Nail" }));
    (await repositories.providers.create({
      id: "provider-1",
      name: "DeepSeek",
      kind: "deepseek",
      status: "ready",
      authMode: "api_key",
      secretReference: "vault://private/provider-key",
      capabilities: ["tools"],
    }));
    (await repositories.providers.create({
      id: "provider-2",
      name: "Codex Subscription",
      kind: "codex",
      status: "unavailable",
      authMode: "subscription_cli",
    }));
    (await repositories.accountBindings.create({
      providerId: "provider-2",
      bindingId: "codex-owner",
      state: "unsupported",
    }));
    (await repositories.accountBindings.updateDiagnostic({
      providerId: "provider-2",
      bindingId: "codex-owner",
      expectedRevision: 0,
      expectedGeneration: 0,
      state: "unsupported",
      reason: "auth_status_unverified",
      checkedAt: "2026-10-20T00:00:00.000Z",
    }));
    (await repositories.agents.create({
      id: "agent-1",
      projectId: "project-1",
      providerId: "provider-1",
      name: "FE",
      role: "frontend",
    }));
    (await repositories.runs.create({
      id: "run-1",
      projectId: "project-1",
      state: "running",
    }));
    (await repositories.tasks.create({
      id: "task-1",
      runId: "run-1",
      title: "Build shell",
      state: "running",
    }));
    (await repositories.approvals.create({
      id: "approval-1",
      runId: "run-1",
      payloadFingerprint: "fingerprint",
      decision: "pending",
    }));
    (await database.close());

    const { handlers, request } = await createAuthenticatedHandlers(path);
    const overview = await handlers.overview(request("/api/overview"));
    const providers = await handlers.providers(request("/api/providers"));
    const records = (await providers.json()) as Array<Record<string, unknown>>;

    expect(await overview.json()).toEqual({
      projectsCount: 1,
      agentsCount: 1,
      agents: [{
        id: "agent-1", name: "FE", role: "frontend", projectId: "project-1",
        providerId: "provider-1", providerName: "DeepSeek", providerStatus: "ready",
        model: null, modelMatchesProvider: false, skillIds: [],
      }],
      activeRunsCount: 1,
      queuedRunsCount: 0,
      pendingApprovalsCount: 1,
    });
    expect(records).toHaveLength(2);
    const deepseek = records.find((record) => record.id === "provider-1");
    const codex = records.find((record) => record.id === "provider-2");
    expect(deepseek).toMatchObject({ id: "provider-1", kind: "deepseek", status: "ready", connection: null });
    expect(codex).toMatchObject({
      id: "provider-2",
      kind: "codex",
      status: "unavailable",
      connection: {
        state: "unsupported",
        reason: "auth_status_unverified",
        checkedAt: "2026-10-20T00:00:00.000Z",
      },
    });
    expect(codex).not.toHaveProperty("secretReference");
    expect(codex).not.toHaveProperty("bindingId");
    expect(codex).not.toHaveProperty("revision");
    expect(records[0]).not.toHaveProperty("secretReference");
    expect(JSON.stringify(records)).not.toContain("vault://private/provider-key");
  });
});
