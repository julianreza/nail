import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { createApprovalService } from "../../../lib/server/runs/approval-service";
import { createRunWorkspace, createCheckpoint } from "../../../lib/server/projects/workspace-service";
import { claimNextJob, finishClaimedRun } from "../../../lib/server/queue/queue-service";
import {
  finalizeVerifiedRun,
  recordQaRound,
} from "../../../lib/server/orchestration/qa-loop";
import {
  proposePlanForApproval,
  selectNextReadyTask,
  setTaskState,
  validatePlanProposal,
} from "../../../lib/server/orchestration/plan-service";

const temporaryDirectories: string[] = [];
const approvalConfig = {
  allowedTools: ["workspace:read", "workspace:write", "terminal:execute"],
  allowedPermissions: ["workspace:read", "workspace:write", "terminal:execute"],
  setupCommands: ["bun install"],
  verificationCommands: ["bun run lint"],
  costLimitMicrounits: 2_000_000,
};

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "nail-orchestration-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function proposal() {
  return {
    goal: "Add a responsive project summary",
    acceptanceCriteria: [{ id: "summary-visible", description: "Project summary is visible" }],
    subtasks: [
      {
        id: "frontend",
        title: "Build summary view",
        description: "Render project summary from stored data",
        ownerAgentId: "agent-fe",
        dependsOn: [],
        requiredTools: ["workspace:write"],
      },
      {
        id: "backend",
        title: "Expose summary API",
        description: "Read the persisted project summary",
        ownerAgentId: "agent-be",
        dependsOn: ["frontend"],
        requiredTools: ["terminal:execute"],
      },
    ],
  };
}

async function createRunDatabase(verificationCommands = ["bun run lint"]) {
  const directory = createTempDirectory();
  const database = (await openDatabase(join(directory, "orchestrator-database")));
  const repositories = createRepositories(database);
  (await repositories.projects.create({ id: "project-1", name: "Nail" }));
  (await repositories.agents.create({ id: "agent-fe", projectId: "project-1", name: "FE", role: "frontend" }));
  (await repositories.agents.create({ id: "agent-be", projectId: "project-1", name: "BE", role: "backend" }));
  (await repositories.agents.create({ id: "agent-qa", projectId: "project-1", name: "QA", role: "qa" }));
  (await repositories.runs.create({
    id: "run-1",
    projectId: "project-1",
    state: "draft",
    planVersion: 1,
    baselineCommit: null,
  }));
  return { database, repositories, directory, verificationCommands };
}

function planContext(verificationCommands = ["bun run lint"]) {
  return {
    ...approvalConfig,
    verificationCommands,
  };
}

async function approvePlan(database: Awaited<ReturnType<typeof openDatabase>>, plan: Awaited<ReturnType<typeof proposePlanForApproval>>) {
  (await createApprovalService(database, { allowedPermissions: approvalConfig.allowedPermissions }).decide(
    plan.approval.id,
    { decision: "approved", expectedFingerprint: plan.approval.payloadFingerprint },
  ));
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("PM plan validation and serial task workflow", () => {
  it("rejects model-authored state, permission, command, cycle, owner, and tool overrides", async () => {
    const { database } = (await createRunDatabase());
    try {
      await expect(async () =>
        (await validatePlanProposal(database, "run-1", { ...proposal(), state: "done" }, planContext())),
      ).rejects.toThrow();
      await expect(async () =>
        (await validatePlanProposal(database, "run-1", { ...proposal(), permissions: ["production:deploy"] }, planContext())),
      ).rejects.toThrow();
      await expect(async () =>
        (await validatePlanProposal(database, "run-1", { ...proposal(), setupCommands: ["curl evil"] }, planContext())),
      ).rejects.toThrow();

      const oversizedTools = proposal();
      oversizedTools.subtasks[0]!.requiredTools = Array.from({ length: 65 }, () => "workspace:write");
      await expect(async () => (await validatePlanProposal(database, "run-1", oversizedTools, planContext()))).rejects.toThrow();
      const oversizedDependencies = proposal();
      oversizedDependencies.subtasks[1]!.dependsOn = Array.from({ length: 41 }, () => "frontend");
      await expect(async () => (await validatePlanProposal(database, "run-1", oversizedDependencies, planContext()))).rejects.toThrow();

      const cyclic = proposal();
      cyclic.subtasks[0]!.dependsOn = ["backend"];
      await expect(async () => (await validatePlanProposal(database, "run-1", cyclic, planContext()))).rejects.toThrow();

      const wrongOwner = proposal();
      wrongOwner.subtasks[0]!.ownerAgentId = "missing-agent";
      await expect(async () => (await validatePlanProposal(database, "run-1", wrongOwner, planContext()))).rejects.toThrow();

      const disallowedTool = proposal();
      disallowedTool.subtasks[0]!.requiredTools = ["network:unrestricted"];
      await expect(async () => (await validatePlanProposal(database, "run-1", disallowedTool, planContext()))).rejects.toThrow();
      expect((await createRepositories(database).runs.getById("run-1"))?.state).toBe("draft");
    } finally {
      (await database.close());
    }
  });

  it("stores a server-bound approval scope and schedules only ready dependency tasks", async () => {
    const { database } = (await createRunDatabase());
    try {
      const submitted = (await proposePlanForApproval(database, "run-1", proposal(), planContext()));
      expect(submitted.approval.decision).toBe("pending");
      expect((await createRepositories(database).runs.getById("run-1"))?.state).toBe("awaiting_approval");
      const storedPlan = (await createRepositories(database).runPlans.getByRunId("run-1"));
      expect(storedPlan?.verificationCommandsJson).toBe('["bun run lint"]');
      expect(storedPlan?.approvalFingerprint).toBe(submitted.approval.payloadFingerprint);

      await expect(async () => (await selectNextReadyTask(database, "run-1"))).rejects.toThrow();
      await approvePlan(database, submitted);
      const claim = (await claimNextJob(database, {
        workerId: "worker-a",
        now: new Date().toISOString(),
        leaseDurationMs: 30_000,
      }));
      expect(claim?.runId).toBe("run-1");
      const frontend = (await selectNextReadyTask(database, "run-1"));
      expect(frontend?.title).toBe("Build summary view");
      const backendTask = (await createRepositories(database).tasks.listForRun("run-1"))[1]!;
      await expect(async () => (await setTaskState(database, backendTask.id, "running", "worker"))).rejects.toThrow();
      (await setTaskState(database, frontend!.id, "running", "worker"));
      expect((await selectNextReadyTask(database, "run-1"))).toBeNull();
      await expect(async () => (await setTaskState(database, backendTask.id, "running", "worker"))).rejects.toThrow();
      (await setTaskState(database, frontend!.id, "done", "worker"));
      expect((await selectNextReadyTask(database, "run-1"))?.title).toBe("Expose summary API");
    } finally {
      (await database.close());
    }
  });

  it("routes QA findings to the owning engineer and blocks after three failed rounds", async () => {
    const { database, repositories } = (await createRunDatabase());
    try {
      const submitted = (await proposePlanForApproval(database, "run-1", proposal(), planContext()));
      await approvePlan(database, submitted);
      const claim = (await claimNextJob(database, {
        workerId: "worker-a",
        now: new Date().toISOString(),
        leaseDurationMs: 30_000,
      }));
      expect(claim?.runId).toBe("run-1");
      const frontend = (await selectNextReadyTask(database, "run-1"))!;
      (await setTaskState(database, frontend.id, "running", "worker"));
      (await setTaskState(database, frontend.id, "done", "worker"));
      const backend = (await selectNextReadyTask(database, "run-1"))!;
      (await setTaskState(database, backend.id, "running", "worker"));
      (await setTaskState(database, backend.id, "done", "worker"));
      expect(
        (await finishClaimedRun(database, {
          workerId: "worker-a",
          runId: "run-1",
          nextState: "awaiting_review",
          now: new Date().toISOString(),
        })),
      ).toBe(true);

      const first = (await recordQaRound(database, {
        runId: "run-1",
        status: "failed",
        details: "Summary count is wrong",
        findings: [{ taskId: backend.id, summary: "Fix summary query" }],
      }));
      expect(first).toMatchObject({ roundNumber: 1, runState: "queued" });
      expect((await repositories.tasks.getById(first.repairTaskIds[0]!))?.ownerAgentId).toBe("agent-be");

      for (let round = 2; round <= 3; round += 1) {
        const retryClaim = (await claimNextJob(database, {
          workerId: `worker-${round}`,
          now: new Date().toISOString(),
          leaseDurationMs: 30_000,
        }));
        expect(retryClaim?.runId).toBe("run-1");
        const repairTask = (await selectNextReadyTask(database, "run-1"))!;
        (await setTaskState(database, repairTask.id, "running", "worker"));
        (await setTaskState(database, repairTask.id, "done", "worker"));
        expect(
          (await finishClaimedRun(database, {
            workerId: `worker-${round}`,
            runId: "run-1",
            nextState: "awaiting_review",
            now: new Date().toISOString(),
          })),
        ).toBe(true);
        const result = (await recordQaRound(database, {
          runId: "run-1",
          status: "failed",
          details: `QA failed round ${round}`,
          findings: [{ taskId: backend.id, summary: `Repair round ${round}` }],
        }));
        if (round === 3) expect(result).toMatchObject({ runState: "blocked", repairTaskIds: [] });
      }
      expect((await repositories.runs.getById("run-1"))?.state).toBe("blocked");
    } finally {
      (await database.close());
    }
  });

  it("requires explicit manual verification when there are no automated checks", async () => {
    const { database, repositories } = (await createRunDatabase([]));
    try {
      const submitted = (await proposePlanForApproval(database, "run-1", proposal(), planContext([])));
      await approvePlan(database, submitted);
      const claim = (await claimNextJob(database, {
        workerId: "worker-manual",
        now: new Date().toISOString(),
        leaseDurationMs: 30_000,
      }));
      expect(claim?.runId).toBe("run-1");
      const planTasks = (await repositories.tasks.listForRun("run-1"));
      for (const task of planTasks) {
        (await setTaskState(database, task.id, "running", "worker"));
        (await setTaskState(database, task.id, "done", "worker"));
      }
      expect(
        (await finishClaimedRun(database, {
          workerId: "worker-manual",
          runId: "run-1",
          nextState: "awaiting_review",
          now: new Date().toISOString(),
        })),
      ).toBe(true);
      (await recordQaRound(database, {
        runId: "run-1",
        status: "passed",
        details: "Manual verification pending",
        verifiedCriteriaIds: ["summary-visible"],
        verifiedCommands: [],
        manualVerificationConfirmed: false,
      }));
      expect((await finalizeVerifiedRun(database, "run-1", { manualVerificationConfirmed: false }))).toBe(false);
      expect((await repositories.runs.getById("run-1"))?.state).toBe("awaiting_review");

      (await recordQaRound(database, {
        runId: "run-1",
        status: "passed",
        details: "Owner confirmed manually",
        verifiedCriteriaIds: ["summary-visible"],
        verifiedCommands: [],
        manualVerificationConfirmed: true,
        manualVerificationActor: "owner",
      }));
      expect((await finalizeVerifiedRun(database, "run-1", {
        manualVerificationConfirmed: true,
        manualVerificationActor: "owner",
      }))).toBe(true);
      expect((await repositories.runs.getById("run-1"))?.state).toBe("done");
    } finally {
      (await database.close());
    }
  });

  it("runs the FE→BE→QA failure→repair→QA pass fixture and returns checkpoint evidence", async () => {
    const { database, directory, repositories } = (await createRunDatabase());
    try {
      const submitted = (await proposePlanForApproval(database, "run-1", proposal(), planContext()));
      await approvePlan(database, submitted);
      const workspace = (await createRunWorkspace(database, {
        runId: "run-1",
        projectId: "project-1",
        sourcePath: null,
        workspaceRoot: join(directory, "workspaces"),
        baselineCommit: null,
        scope: {
          planVersion: 1,
          baselineCommit: null,
          setupCommands: ["bun install"],
          verificationCommands: ["bun run lint"],
          permissions: approvalConfig.allowedPermissions,
          costLimitMicrounits: approvalConfig.costLimitMicrounits,
        },
        allowedPermissions: approvalConfig.allowedPermissions,
      }));
      const claim = (await claimNextJob(database, { workerId: "worker-a", now: new Date().toISOString(), leaseDurationMs: 30_000 }));
      expect(claim?.runId).toBe("run-1");

      const frontend = (await selectNextReadyTask(database, "run-1"))!;
      (await setTaskState(database, frontend.id, "running", "worker"));
      writeFileSync(join(workspace.workspacePath, "summary.tsx"), "export const Summary = () => null;\n");
      (await setTaskState(database, frontend.id, "done", "worker"));
      const backend = (await selectNextReadyTask(database, "run-1"))!;
      (await setTaskState(database, backend.id, "running", "worker"));
      writeFileSync(join(workspace.workspacePath, "summary-api.ts"), "export const getSummary = () => ({});\n");
      (await setTaskState(database, backend.id, "done", "worker"));
      const firstCheckpoint = (await createCheckpoint(database, { runId: "run-1", taskId: backend.id }));
      expect(firstCheckpoint.changedFiles.map((file) => file.path)).toContain("summary-api.ts");
      expect((await finishClaimedRun(database, {
        workerId: "worker-a",
        runId: "run-1",
        nextState: "awaiting_review",
        now: new Date().toISOString(),
      }))).toBe(true);

      const qaFail = (await recordQaRound(database, {
        runId: "run-1",
        status: "failed",
        details: "API response shape needs a fix",
        findings: [{ taskId: backend.id, summary: "Return counts from the database" }],
      }));
      expect(qaFail.runState).toBe("queued");
      const nextClaim = (await claimNextJob(database, { workerId: "worker-b", now: new Date().toISOString(), leaseDurationMs: 30_000 }));
      expect(nextClaim?.runId).toBe("run-1");
      const repair = (await selectNextReadyTask(database, "run-1"))!;
      expect(repair.ownerAgentId).toBe("agent-be");
      (await setTaskState(database, repair.id, "running", "worker"));
      writeFileSync(join(workspace.workspacePath, "summary-api.ts"), "export const getSummary = () => ({ projects: 0 });\n");
      (await setTaskState(database, repair.id, "done", "worker"));
      const finalCheckpoint = (await createCheckpoint(database, { runId: "run-1", taskId: repair.id }));
      expect(finalCheckpoint.changedFiles.some((file) => file.path === "summary-api.ts" && file.status === "added")).toBe(true);
      expect((await finishClaimedRun(database, {
        workerId: "worker-b",
        runId: "run-1",
        nextState: "awaiting_review",
        now: new Date().toISOString(),
      }))).toBe(true);
      (await recordQaRound(database, {
        runId: "run-1",
        status: "passed",
        details: "Acceptance criteria and verification command passed",
        verifiedCriteriaIds: ["summary-visible"],
        verifiedCommands: ["bun run lint"],
      }));
      expect((await finalizeVerifiedRun(database, "run-1", { manualVerificationConfirmed: false }))).toBe(true);
      expect((await repositories.runs.getById("run-1"))?.state).toBe("done");
      expect((await repositories.checkpoints.listForRun("run-1"))).toHaveLength(2);
    } finally {
      (await database.close());
    }
  });
});
