import { describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { createApprovalService, type ApprovalScope } from "../../../lib/server/runs/approval-service";
import { claimNextJob } from "../../../lib/server/queue/queue-service";
import { runTaskToolLoop, type TaskModelReply } from "../../../lib/server/orchestration/tool-loop";

function fixture() {
  const db = openDatabase(":memory:");
  const repos = createRepositories(db);
  repos.projects.create({ id: "p", name: "Project" });
  repos.agents.create({ id: "a", projectId: "p", name: "Engineer", role: "engineer" });
  repos.runs.create({ id: "r", projectId: "p", state: "draft" });
  const scope: ApprovalScope = {
    planVersion: 1, baselineCommit: null, setupCommands: [],
    verificationCommands: ["printf verified"], permissions: ["terminal:execute"],
    costLimitMicrounits: 100,
  };
  const service = createApprovalService(db, { allowedPermissions: scope.permissions });
  const approval = service.submitForApproval("r", scope);
  service.decide(approval.id, { decision: "approved", expectedFingerprint: approval.payloadFingerprint });
  claimNextJob(db, { workerId: "worker", now: new Date().toISOString(), leaseDurationMs: 30_000 });
  repos.tasks.create({ id: "t", runId: "r", ownerAgentId: "a", title: "Verify", state: "running" });
  return { db, repos, scope };
}

const call: TaskModelReply = {
  content: null,
  toolCalls: [{ id: "call-1", type: "function", function: { name: "run_command", arguments: '{"command":"printf verified"}' } }],
};

describe("bounded sandbox tool loop", () => {
  it("feeds real command results back to the model and records exit evidence", async () => {
    const { db, repos, scope } = fixture();
    let requests = 0;
    let commands = 0;
    try {
      const result = await runTaskToolLoop({
        database: db, runId: "r", taskId: "t", workerId: "worker", scope,
        allowedPermissions: scope.permissions, maxModelRequests: 3, maxToolCalls: 2,
        model: async (messages) => {
          requests += 1;
          if (requests === 1) return call;
          expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
          expect(messages.at(-1)?.content).toContain('"exitCode":0');
          expect(messages.at(-2)?.tool_calls).toEqual(call.toolCalls);
          return { content: "Finished", toolCalls: [] };
        },
        executeInSandbox: async (command) => {
          commands += 1;
          expect(command).toBe("printf verified");
          return { exitCode: 0, stdout: "verified", stderr: "", outputTruncated: false };
        },
      });
      expect(result).toMatchObject({ reason: "model_finished", modelRequests: 2, toolCalls: 1 });
      expect(result.failedCommands).toBe(0);
      expect(commands).toBe(1);
      expect(repos.events.listAfter("r", 0).some((event) => event.eventType === "tool.completed")).toBe(true);
      expect(repos.tasks.getById("t")?.state).toBe("running");
    } finally { db.close(); }
  });

  it.each(["unapproved command", "wrong lease", "stale baseline", "cancelled"])(
    "blocks %s before sandbox side effects", async (condition) => {
      const { db, scope } = fixture();
      let commands = 0;
      const controller = new AbortController();
      if (condition === "wrong lease") db.prepare("UPDATE leases SET worker_id = 'other'").run();
      if (condition === "stale baseline") db.prepare("UPDATE runs SET baseline_commit = 'changed'").run();
      if (condition === "cancelled") controller.abort();
      try {
        await expect(runTaskToolLoop({
          database: db, runId: "r", taskId: "t", workerId: "worker", scope,
          allowedPermissions: scope.permissions, maxModelRequests: 2, maxToolCalls: 1,
          signal: controller.signal,
          model: async () => condition === "unapproved command"
            ? { content: null, toolCalls: [{ ...call.toolCalls[0]!, function: { name: "run_command", arguments: '{"command":"rm anything"}' } }] }
            : call,
          executeInSandbox: async () => {
            commands += 1;
            return { exitCode: 0, stdout: "", stderr: "", outputTruncated: false };
          },
        })).rejects.toThrow();
        expect(commands).toBe(0);
      } finally { db.close(); }
    },
  );

  it("rejects duplicate tool-call IDs without replaying the command", async () => {
    const { db, scope } = fixture();
    let commands = 0;
    try {
      await expect(runTaskToolLoop({
        database: db, runId: "r", taskId: "t", workerId: "worker", scope,
        allowedPermissions: scope.permissions, maxModelRequests: 3, maxToolCalls: 3,
        model: async () => call,
        executeInSandbox: async () => {
          commands += 1;
          return { exitCode: 1, stdout: "", stderr: "failure", outputTruncated: false };
        },
      })).rejects.toThrow(/duplicate/i);
      expect(commands).toBe(1);
    } finally { db.close(); }
  });

  it("stops at the request cap instead of looping indefinitely", async () => {
    const { db, scope } = fixture();
    try {
      const result = await runTaskToolLoop({
        database: db, runId: "r", taskId: "t", workerId: "worker", scope,
        allowedPermissions: scope.permissions, maxModelRequests: 1, maxToolCalls: 1,
        model: async () => call,
        executeInSandbox: async () => ({ exitCode: 0, stdout: "ok", stderr: "", outputTruncated: false }),
      });
      expect(result.reason).toBe("request_limit");
    } finally { db.close(); }
  });

  it("reports non-zero command results so the executor cannot treat them as task success", async () => {
    const { db, scope } = fixture();
    let requests = 0;
    try {
      const result = await runTaskToolLoop({
        database: db, runId: "r", taskId: "t", workerId: "worker", scope,
        allowedPermissions: scope.permissions, maxModelRequests: 2, maxToolCalls: 1,
        model: async () => requests++ === 0 ? call : { content: "Finished anyway", toolCalls: [] },
        executeInSandbox: async () => ({ exitCode: 9, stdout: "", stderr: "verification failed", outputTruncated: false }),
      });
      expect(result.reason).toBe("model_finished");
      expect(result.failedCommands).toBe(1);
    } finally { db.close(); }
  });
});
