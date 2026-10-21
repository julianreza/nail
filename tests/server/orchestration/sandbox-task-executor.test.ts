import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { proposePlanForApproval } from "../../../lib/server/orchestration/plan-service";
import { createApprovalService } from "../../../lib/server/runs/approval-service";
import { configureRunUsageBudget } from "../../../lib/server/providers/usage-budget";
import { runWorkerOnce } from "../../../worker/runner";
import { createSandboxTaskExecutor } from "../../../lib/server/orchestration/sandbox-task-executor";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nail-executor-"));
  const working = join(root, "working");
  const baseline = join(root, "baseline");
  mkdirSync(working); mkdirSync(baseline);
  const db = (await openDatabase(join(root, "db-database")));
  const repos = createRepositories(db);
  (await repos.projects.create({ id: "p", name: "Project" }));
  (await repos.providers.create({ id: "provider", name: "DeepSeek", status: "ready", authMode: "api_key" }));
  (await repos.agents.create({ id: "a", projectId: "p", providerId: "provider", name: "Engineer", role: "engineer" }));
  (await repos.runs.create({ id: "r", projectId: "p", state: "draft" }));
  const permissions = ["terminal:execute"];
  const submitted = (await proposePlanForApproval(db, "r", {
    goal: "Read UID", acceptanceCriteria: [{ id: "uid", description: "Non-root" }],
    subtasks: [{ id: "uid", title: "Read UID", description: "Read UID", ownerAgentId: "a", requiredTools: permissions, dependsOn: [] }],
  }, { allowedTools: permissions, allowedPermissions: permissions, setupCommands: [], verificationCommands: ["id -u"], costLimitMicrounits: 100 }));
  (await createApprovalService(db, { allowedPermissions: permissions }).decide(submitted.approval.id, {
    decision: "approved", expectedFingerprint: submitted.approval.payloadFingerprint,
  }));
  (await repos.workspaces.create({ id: "w", runId: "r", projectId: "p", sourcePath: null, workspacePath: working, baselinePath: baseline, baselineCommit: null, setupCommands: [], verificationCommands: ["id -u"] }));
  (await configureRunUsageBudget(db, { runId: "r", maxRequests: 3, maxToolCalls: 2, maxOutputTokens: 1000 }));
  return { db, repos, root, permissions };
}

describe("worker to provider and sandbox bridge", () => {
  it("passes the approved command through sandbox, checkpoints, and ends at review not done", async () => {
    const { db, repos, root, permissions } = (await fixture());
    let modelRequests = 0;
    let stopped = false;
    let commandCount = 0;
    try {
      const execute = createSandboxTaskExecutor({
        database: db, workerId: "worker", allowedPermissions: permissions, image: "trusted:1",
        maxRequestsPerTask: 3, maxToolCallsPerTask: 2, maxOutputTokensPerRequest: 100,
        sandbox: {
          start: async () => ({ containerId: "container", runId: "r" }),
          execute: async (_handle, command) => {
            expect(command).toBe("id -u"); commandCount += 1;
            return { exitCode: 0, stdout: "10001\n", stderr: "", outputTruncated: false };
          },
          stop: async () => { await Promise.resolve(); stopped = true; },
        },
        provider: {
          complete: async (request) => {
            modelRequests += 1;
            expect(request).toMatchObject({ providerId: "provider", stream: false, maxOutputTokens: 100 });
            if (modelRequests === 2) expect(request.messages.at(-1)?.content).toContain("10001");
            return { kind: "complete", id: "reply", model: "fixture", content: modelRequests === 1 ? null : "Finished", usage: null, reservationId: "fixture",
              finishReason: modelRequests === 1 ? "tool_calls" : "stop",
              toolCalls: modelRequests === 1 ? [{ id: "uid", type: "function", function: { name: "run_command", arguments: '{"command":"id -u"}' } }] : [],
            };
          },
        },
      });
      const result = await runWorkerOnce({ database: db, workerId: "worker", execute });
      expect(result).toMatchObject({ state: "awaiting_review", finalized: true });
      expect(commandCount).toBe(1);
      expect(stopped).toBe(true);
      expect((await repos.checkpoints.listForRun("r"))).toHaveLength(1);
      expect((await repos.leases.get())).toBeNull();
      expect((await repos.runs.getById("r"))?.state).toBe("awaiting_review");
    } finally { (await db.close()); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not call the model when sandbox startup fails", async () => {
    const { db, repos, root, permissions } = (await fixture());
    let modelRequests = 0;
    try {
      const execute = createSandboxTaskExecutor({
        database: db, workerId: "worker", allowedPermissions: permissions, image: "trusted:1",
        maxRequestsPerTask: 3, maxToolCallsPerTask: 2, maxOutputTokensPerRequest: 100,
        sandbox: {
          start: async () => { throw new Error("preflight failed"); },
          execute: async () => { throw new Error("must not execute"); },
          stop: async () => {},
        },
        provider: { complete: async () => { modelRequests += 1; throw new Error("must not call model"); } },
      });
      const result = await runWorkerOnce({ database: db, workerId: "worker", execute });
      expect(result).toMatchObject({ state: "failed", finalized: true });
      expect(modelRequests).toBe(0);
      expect((await repos.tasks.listForRun("r"))[0]?.state).toBe("queued");
    } finally { (await db.close()); rmSync(root, { recursive: true, force: true }); }
  });

  it("blocks the task when an approved command fails even if the model claims completion", async () => {
    const { db, repos, root, permissions } = (await fixture());
    let modelRequests = 0;
    try {
      const execute = createSandboxTaskExecutor({
        database: db, workerId: "worker", allowedPermissions: permissions, image: "trusted:1",
        maxRequestsPerTask: 3, maxToolCallsPerTask: 2, maxOutputTokensPerRequest: 100,
        sandbox: {
          start: async () => ({ containerId: "container", runId: "r" }),
          execute: async () => ({ exitCode: 9, stdout: "", stderr: "UID check failed", outputTruncated: false }),
          stop: async () => {},
        },
        provider: {
          complete: async () => {
            modelRequests += 1;
            return modelRequests === 1
              ? { kind: "complete", id: "reply-1", model: "fixture", content: null, usage: null, reservationId: "fixture", finishReason: "tool_calls", toolCalls: [{ id: "uid", type: "function", function: { name: "run_command", arguments: '{"command":"id -u"}' } }] }
              : { kind: "complete", id: "reply-2", model: "fixture", content: "Finished", usage: null, reservationId: "fixture", finishReason: "stop", toolCalls: [] };
          },
        },
      });
      const result = await runWorkerOnce({ database: db, workerId: "worker", execute });
      expect(result).toMatchObject({ state: "blocked", finalized: true });
      expect((await repos.tasks.listForRun("r"))[0]?.state).toBe("blocked");
      expect((await repos.checkpoints.listForRun("r"))).toHaveLength(0);
    } finally { (await db.close()); rmSync(root, { recursive: true, force: true }); }
  });
});
