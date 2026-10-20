import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthHandlers, hashOwnerPassword } from "../../../lib/server/auth/auth-service";
import { createRepositories, openDatabase } from "../../../lib/server/db/database";
import { createProjectRunsReadHandler } from "../../../lib/server/dashboard/project-runs-read";

const tempDirs: string[] = [];

async function createAuthFixture() {
  const auth = createAuthHandlers({
    ownerPasswordHash: await hashOwnerPassword("valid test password", {
      salt: Buffer.alloc(16, 4),
    }),
    sessionSecret: Buffer.alloc(32, 5).toString("base64url"),
    appOrigin: "https://nail.example",
    secureCookies: true,
  });
  const login = await auth.login(
    new Request("https://nail.example/api/auth/login", {
      method: "POST",
      headers: { origin: "https://nail.example", "content-type": "application/json" },
      body: JSON.stringify({ password: "valid test password" }),
    }),
  );
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  return {
    auth,
    request: new Request("https://nail.example/api/projects/project-1/runs", {
      headers: { cookie },
    }),
  };
}

function createDbPath() {
  const directory = mkdtempSync(join(tmpdir(), "nail-project-runs-test-"));
  tempDirs.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("project run detail read model", () => {
  it("returns the stored plan, dependency order, and approval without secrets", async () => {
    const path = createDbPath();
    const database = openDatabase(path);
    const repositories = createRepositories(database);
    repositories.projects.create({ id: "project-1", name: "Nail" });
    repositories.providers.create({
      id: "provider-1",
      name: "DeepSeek",
      status: "needs_login",
      model: "deepseek-chat",
      authMode: "api_key",
      secretReference: "secret:private-reference",
      capabilities: ["tools"],
    });
    repositories.runs.create({ id: "run-1", projectId: "project-1", state: "awaiting_approval" });
    repositories.approvals.create({
      id: "approval-1",
      runId: "run-1",
      payloadFingerprint: "fingerprint",
      decision: "pending",
      planVersion: 1,
      baselineCommit: null,
      scopeJson: JSON.stringify({ setupCommands: ["bun install"], permissions: ["workspace:write"] }),
    });
    repositories.runPlans.create({
      runId: "run-1",
      planVersion: 1,
      goal: "Create summary",
      acceptanceCriteriaJson: JSON.stringify([{ id: "visible", description: "Summary appears" }]),
      setupCommandsJson: JSON.stringify(["bun install"]),
      verificationCommandsJson: JSON.stringify(["bun run lint"]),
      allowedToolsJson: JSON.stringify(["workspace:write"]),
      approvalId: "approval-1",
      approvalFingerprint: "fingerprint",
    });
    repositories.tasks.create({ id: "task-1", runId: "run-1", title: "First", state: "done", position: 0 });
    repositories.tasks.create({ id: "task-2", runId: "run-1", title: "Second", state: "queued", position: 1 });
    repositories.taskDependencies.set("task-2", ["task-1"]);
    const authFixture = await createAuthFixture();
    const handler = createProjectRunsReadHandler(authFixture.auth, path);
    try {
      const response = await handler("project-1", authFixture.request);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        project: { id: string };
        providers: Array<Record<string, unknown>>;
        runs: Array<{ plan: { goal: string }; tasks: Array<{ id: string; dependsOn: string[] }> }>;
      };
      expect(body.project.id).toBe("project-1");
      expect(body.runs[0]?.plan.goal).toBe("Create summary");
      expect(body.runs[0]?.tasks[1]).toMatchObject({ id: "task-2", dependsOn: ["task-1"] });
      expect(JSON.stringify(body)).not.toContain("secret:private-reference");
    } finally {
      database.close();
    }
  });

  it("rejects unauthenticated project run detail", async () => {
    const handler = createProjectRunsReadHandler(
      { protectedResource: async () => Response.json({ error: "Unauthorized" }, { status: 401 }) },
      createDbPath(),
    );
    const response = await handler("project-1", new Request("https://nail.example/api/projects/project-1/runs"));
    expect(response.status).toBe(401);
  });
});
