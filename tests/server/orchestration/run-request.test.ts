import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { getRemainingUsageBudget, reserveProviderRequest, completeProviderUsage } from "../../../lib/server/providers/usage-budget";
import { createRunPlanFromGoal, type PlanGeneratorInput } from "../../../lib/server/orchestration/run-request";

const tempDirs: string[] = [];
const allowedPermissions = ["workspace:read", "workspace:write", "terminal:execute"];
const allowedTools = ["workspace:read", "workspace:write", "terminal:execute"];

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "nail-run-request-test-"));
  tempDirs.push(directory);
  const database = openDatabase(join(directory, "db.sqlite"));
  const repos = createRepositories(database);
  repos.projects.create({ id: "project-1", name: "Nail" });
  repos.agents.create({ id: "agent-fe", projectId: "project-1", name: "FE", role: "frontend" });
  repos.agents.create({ id: "agent-be", projectId: "project-1", name: "BE", role: "backend" });
  repos.providers.create({
    id: "deepseek-1",
    name: "DeepSeek",
    kind: "deepseek",
    status: "ready",
    model: "deepseek-chat",
    authMode: "api_key",
    secretReference: "secret:already-encrypted-reference",
    capabilities: [],
  });
  return { database, repos };
}

const generatedPlan = {
  goal: "Add a project summary",
  acceptanceCriteria: [{ id: "summary", description: "Show real project counts" }],
  subtasks: [
    {
      id: "fe",
      title: "Render summary",
      description: "Show project counts in UI",
      ownerAgentId: "agent-fe",
      dependsOn: [],
      requiredTools: ["workspace:write"],
    },
    {
      id: "be",
      title: "Read counts",
      description: "Read actual persisted counts",
      ownerAgentId: "agent-be",
      dependsOn: ["fe"],
      requiredTools: ["workspace:read"],
    },
  ],
};

const request = {
  projectId: "project-1",
  providerId: "deepseek-1",
  goal: "Add a project summary",
  setupCommands: ["bun install"],
  verificationCommands: ["bun run lint"],
  maxRequests: 5,
  maxToolCalls: 10,
  maxOutputTokens: 4000,
  costLimitMicrounits: 5_000_000,
};

const policy = { allowedPermissions, allowedTools };

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("requesting an approved PM plan", () => {
  it("creates a bounded draft request and stores only a server-validated plan", async () => {
    const { database, repos } = createDatabase();
    let generatedWith: unknown;
    try {
      const result = await createRunPlanFromGoal(database, request, policy, async (input: PlanGeneratorInput) => {
        generatedWith = input;
        const reservation = reserveProviderRequest(database, {
          runId: input.runId,
          providerId: input.providerId,
          maxOutputTokens: input.maxOutputTokens,
        });
        completeProviderUsage(database, reservation.id, {
          inputTokens: 20,
          outputTokens: 10,
          toolCalls: 0,
        });
        return generatedPlan;
      });
      expect(result.plan.goal).toBe("Add a project summary");
      expect(result.approval.decision).toBe("pending");
      expect(repos.runs.getById(result.runId)?.state).toBe("awaiting_approval");
      expect(repos.runPlans.getByRunId(result.runId)?.setupCommandsJson).toBe('["bun install"]');
      expect(getRemainingUsageBudget(database, result.runId)).toMatchObject({
        requests: 4,
        toolCalls: 10,
        outputTokens: 3990,
      });
      expect(generatedWith).toMatchObject({
        providerId: "deepseek-1",
        allowedTools,
        maxOutputTokens: 4000,
      });
    } finally {
      database.close();
    }
  });

  it("accepts a ready subscription provider without requiring or reading an API-key secret", async () => {
    const { database, repos } = createDatabase();
    const subscription = repos.providers.create({
      id: "codex-1",
      name: "Renamed account label",
      kind: "codex",
      status: "ready",
      model: "gpt-codex-model",
      authMode: "subscription_cli",
    });
    repos.accountBindings.create({ providerId: subscription.id, bindingId: "codex-owner", state: "ready" });
    try {
      const result = await createRunPlanFromGoal(
        database,
        { ...request, providerId: subscription.id },
        policy,
        async () => generatedPlan,
      );
      expect(repos.runs.getById(result.runId)?.state).toBe("awaiting_approval");
      expect(repos.usageRecords.list().every((usage) => usage.providerId === subscription.id)).toBe(true);
      expect(repos.providers.getById(subscription.id)?.secretReference).toBeNull();
    } finally {
      database.close();
    }
  });

  it("fails the draft safely when the planner fails and does not fall back", async () => {
    const { database, repos } = createDatabase();
    let calls = 0;
    try {
      await expect(
        createRunPlanFromGoal(database, request, policy, async (input: PlanGeneratorInput) => {
          calls += 1;
          reserveProviderRequest(database, {
            runId: input.runId,
            providerId: input.providerId,
            maxOutputTokens: input.maxOutputTokens,
          });
          throw new Error("provider unavailable");
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
      expect(repos.runs.list().map((run) => run.state)).toEqual(["failed"]);
      expect(repos.approvals.list()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("refuses credential-like goal text before asking a provider", async () => {
    const { database, repos } = createDatabase();
    let calls = 0;
    try {
      await expect(
        createRunPlanFromGoal(
          database,
          { ...request, goal: "Use this key sk-abcdefghijklmnopqrstuvwxyz123456" },
          policy,
          async () => {
            calls += 1;
            return generatedPlan;
          },
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(repos.runs.list()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
