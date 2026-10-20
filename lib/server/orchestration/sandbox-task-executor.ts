import type { DatabaseSync } from "node:sqlite";
import type { DeepSeekRequest, DeepSeekResult } from "../providers/deepseek-adapter";
import { getRemainingUsageBudget } from "../providers/usage-budget";
import { createRepositories } from "../db/repositories";
import { createApprovalService, type ApprovalScope } from "../runs/approval-service";
import { createCheckpoint } from "../projects/workspace-service";
import { selectNextReadyTask, setTaskState } from "./plan-service";
import { COMMAND_TOOL, runTaskToolLoop } from "./tool-loop";
import type { RootlessDockerSandbox } from "../../../worker/sandbox/runtime";
import type { JobExecutor } from "../../../worker/runner";

interface TaskProvider {
  complete(request: DeepSeekRequest): Promise<DeepSeekResult>;
}

type TaskSandbox = Pick<RootlessDockerSandbox, "start" | "execute" | "stop">;

export interface SandboxTaskExecutorOptions {
  database: DatabaseSync;
  workerId: string;
  allowedPermissions: readonly string[];
  image: string;
  sandbox: TaskSandbox;
  provider: TaskProvider;
  maxRequestsPerTask: number;
  maxToolCallsPerTask: number;
  maxOutputTokensPerRequest: number;
}

// Supply this executor to startWorkerProcess/runWorkerOnce with the SAME DB and workerId.
// It runs engineer tasks only. QA remains a separate evidence-gated stage.
export function createSandboxTaskExecutor(options: SandboxTaskExecutorOptions): JobExecutor {
  for (const value of [options.maxRequestsPerTask, options.maxToolCallsPerTask, options.maxOutputTokensPerRequest]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Executor caps must be positive integers");
  }
  return async (runId, signal) => {
    const repos = createRepositories(options.database);
    const plan = repos.runPlans.getByRunId(runId);
    const workspace = repos.workspaces.getByRunId(runId);
    const run = repos.runs.getById(runId);
    if (!plan || !workspace || workspace.state !== "ready" || !run || run.state !== "running") {
      return { state: "blocked" };
    }
    const approval = repos.approvals.getById(plan.approvalId);
    if (!approval || approval.payloadFingerprint !== plan.approvalFingerprint) return { state: "blocked" };
    const scope = JSON.parse(approval.scopeJson) as ApprovalScope;
    const auth = createApprovalService(options.database, { allowedPermissions: options.allowedPermissions });
    if (!auth.isExecutionApproved(runId, scope) || workspace.baselineCommit !== run.baselineCommit) {
      return { state: "blocked" };
    }
    const lease = repos.leases.get();
    if (!lease || lease.runId !== runId || lease.workerId !== options.workerId || Date.parse(lease.expiresAt) <= Date.now()) {
      return { state: "blocked" };
    }
    if (repos.tasks.listForRun(runId).length === 0) return { state: "blocked" };
    while (!signal.aborted) {
      const task = selectNextReadyTask(options.database, runId);
      if (!task) {
        return { state: repos.tasks.listForRun(runId).every((item) => item.state === "done") ? "awaiting_review" : "blocked" };
      }
      const agent = task.ownerAgentId ? repos.agents.getById(task.ownerAgentId) : null;
      if (!agent?.providerId) return { state: "blocked" };
      // Sandbox start is fail-closed and happens before any model request.
      const handle = await options.sandbox.start({
        runId,
        image: options.image,
        workspacePath: workspace.workspacePath,
        baselinePath: workspace.baselinePath,
        approvedCommands: [...scope.setupCommands, ...scope.verificationCommands],
      });
      try {
        setTaskState(options.database, task.id, "running", "worker");
        const result = await runTaskToolLoop({
          database: options.database,
          runId,
          taskId: task.id,
          workerId: options.workerId,
          scope,
          allowedPermissions: options.allowedPermissions,
          maxModelRequests: options.maxRequestsPerTask,
          maxToolCalls: options.maxToolCallsPerTask,
          signal,
          model: async (messages) => {
            const remaining = getRemainingUsageBudget(options.database, runId);
            if (remaining.requests < 1 || remaining.outputTokens < 1 || remaining.toolCalls < 1) {
              throw new Error("Run usage budget exhausted");
            }
            const reply = await options.provider.complete({
              runId,
              providerId: agent.providerId!,
              messages: [...messages],
              maxOutputTokens: Math.min(options.maxOutputTokensPerRequest, remaining.outputTokens),
              tools: [COMMAND_TOOL],
              stream: false,
              signal,
            });
            if (reply.kind !== "complete") throw new Error("Task executor requires non-stream tool replies");
            return { content: reply.content, toolCalls: reply.toolCalls };
          },
          executeInSandbox: (command) => options.sandbox.execute(handle, command, signal),
        });
        if (result.reason !== "model_finished" || result.failedCommands > 0) {
          setTaskState(options.database, task.id, "blocked", "worker");
          return { state: "blocked" };
        }
        createCheckpoint(options.database, { runId, taskId: task.id });
        setTaskState(options.database, task.id, "done", "worker");
      } finally {
        // Do not release the worker lease until container teardown completes.
        await options.sandbox.stop(handle);
      }
    }
    return { state: "cancelled" };
  };
}
