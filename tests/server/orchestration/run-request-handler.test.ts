import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { createRunRequestHandler } from "../../../lib/server/orchestration/run-request-handler";
import { createRunPlanFromGoal } from "../../../lib/server/orchestration/run-request";
import type { ModelPlanProposal } from "../../../lib/server/orchestration/plan-service";

const roots: string[] = [];
const origin = "http://localhost:3000";
const proposal: ModelPlanProposal = {
  goal: "Add a health endpoint",
  acceptanceCriteria: [{ id: "health", description: "Health route returns 200" }],
  subtasks: [{
    id: "task1",
    title: "Add health handler",
    description: "Implement the approved health route",
    ownerAgentId: "engineer-1",
    dependsOn: [],
    requiredTools: [],
  }],
};

function setup(options: { authenticated?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nail-run-handler-"));
  roots.push(root);
  const databasePath = join(root, "app.sqlite");
  const database = openDatabase(databasePath);
  const repos = createRepositories(database);
  repos.projects.create({ id: "project-1", name: "Nail" });
  repos.agents.create({ id: "engineer-1", projectId: "project-1", name: "Engineer", role: "engineer" });
  repos.providers.create({
    id: "deepseek-1", name: "DeepSeek", kind: "deepseek", status: "ready",
    model: "deepseek-chat", authMode: "api_key", secretReference: "secret:ref",
  });
  database.close();

  const handler = createRunRequestHandler({
    auth: {
      protectedResource: async () => options.authenticated === false
        ? Response.json({ error: "Unauthorized" }, { status: 401 })
        : Response.json({ authenticated: true }),
    },
    appOrigin: origin,
    databasePath,
    policy: {
      allowedTools: ["workspace:read"],
      allowedPermissions: ["workspace:read"],
    },
    createPlanGenerator: () => async () => proposal,
  });
  return { databasePath, handler };
}

const body = {
  providerId: "deepseek-1",
  goal: "Add a health endpoint",
  setupCommands: [],
  verificationCommands: [],
  maxRequests: 4,
  maxToolCalls: 1,
  maxOutputTokens: 4000,
  costLimitMicrounits: 1_000_000,
};

function post(value: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/projects/project-1/runs`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("owner-only project run requests", () => {
  it("creates a provider-generated plan that stops at owner approval", async () => {
    const context = setup();
    const response = await context.handler("project-1", post(body));
    const result = await response.json() as { runId: string; plan: unknown; approval: { decision: string } };
    const database = openDatabase(context.databasePath);
    try {
      expect(response.status, JSON.stringify(result)).toBe(201);
      expect(result.approval.decision).toBe("pending");
      expect(createRepositories(database).runs.getById(result.runId)?.state).toBe("awaiting_approval");
      expect(JSON.stringify(result)).not.toContain("secret:ref");
    } finally {
      database.close();
    }
  });

  it("runs the same valid request through the domain before the HTTP wrapper", async () => {
    const context = setup();
    const database = openDatabase(context.databasePath);
    try {
      const result = await createRunPlanFromGoal(database, { ...body, projectId: "project-1" }, {
        allowedTools: ["workspace:read"],
        allowedPermissions: ["workspace:read"],
      }, async () => proposal);
      expect(result.approval.decision).toBe("pending");
    } finally {
      database.close();
    }
  });

  it("rejects unauthenticated, cross-origin and malformed requests before creating a run", async () => {
    const unauthenticated = setup({ authenticated: false });
    expect((await unauthenticated.handler("project-1", post(body))).status).toBe(401);

    const wrongOrigin = setup();
    expect((await wrongOrigin.handler("project-1", post(body, "https://evil.invalid"))).status).toBe(403);

    const zeroToolCalls = setup();
    expect((await zeroToolCalls.handler("project-1", post({ ...body, maxToolCalls: 0 }))).status).toBe(400);
    const malformed = setup();
    expect((await malformed.handler("project-1", post("{bad-json"))).status).toBe(400);
    const extraField = setup();
    expect((await extraField.handler("project-1", post({ ...body, command: "whoami" }))).status).toBe(400);
  });
});
