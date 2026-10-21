import { randomUUID } from "node:crypto";
import type { Database } from "../db/database";
import { validateTaskDag } from "../../domain/task-dag";
import { createRepositories } from "../db/repositories";
import { withTransaction } from "../db/database";
import { createApprovalService, type ApprovalScope } from "../runs/approval-service";

export interface PlanAcceptanceCriterion {
  id: string;
  description: string;
}

export interface PlanSubtask {
  id: string;
  title: string;
  description: string;
  ownerAgentId: string;
  dependsOn: string[];
  requiredTools: string[];
}

export interface ModelPlanProposal {
  goal: string;
  acceptanceCriteria: PlanAcceptanceCriterion[];
  subtasks: PlanSubtask[];
}

export interface PlanValidationContext {
  allowedTools: readonly string[];
  allowedPermissions: readonly string[];
  setupCommands: readonly string[];
  verificationCommands: readonly string[];
  costLimitMicrounits: number;
}

export interface ValidatedPlan extends ModelPlanProposal {
  runId: string;
  planVersion: number;
  baselineCommit: string | null;
  subtasks: Array<PlanSubtask & { taskId: string }>;
}

const MODEL_PLAN_FIELDS = ["acceptanceCriteria", "goal", "subtasks"] as const;
const CRITERION_FIELDS = ["description", "id"] as const;
const SUBTASK_FIELDS = [
  "dependsOn",
  "description",
  "id",
  "ownerAgentId",
  "requiredTools",
  "title",
] as const;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

function objectWithExactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function isStringArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value) &&
    value.length <= maxLength &&
    value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 4096);
}

function validateServerContext(context: PlanValidationContext): void {
  if (
    !isStringArray([...context.allowedTools], 64) ||
    new Set(context.allowedTools).size !== context.allowedTools.length ||
    !isStringArray([...context.allowedPermissions], 64) ||
    new Set(context.allowedPermissions).size !== context.allowedPermissions.length ||
    !isStringArray([...context.setupCommands], 100) ||
    !isStringArray([...context.verificationCommands], 100) ||
    !Number.isSafeInteger(context.costLimitMicrounits) ||
    context.costLimitMicrounits <= 0
  ) {
    throw new Error("Server plan policy is invalid");
  }
}

function normalizeProposal(value: unknown, context: PlanValidationContext): ModelPlanProposal {
  validateServerContext(context);
  if (!objectWithExactFields(value, MODEL_PLAN_FIELDS)) {
    throw new Error("Model plan contains unsupported fields");
  }
  const goal = value.goal;
  const criteriaValue = value.acceptanceCriteria;
  const subtasksValue = value.subtasks;
  if (typeof goal !== "string" || goal.trim().length === 0 || goal.length > 5000) {
    throw new Error("Model plan goal is invalid");
  }
  if (!Array.isArray(criteriaValue) || criteriaValue.length === 0 || criteriaValue.length > 50) {
    throw new Error("Model plan must include acceptance criteria");
  }
  const acceptanceCriteria = criteriaValue.map((item) => {
    if (!objectWithExactFields(item, CRITERION_FIELDS)) {
      throw new Error("Acceptance criterion contains unsupported fields");
    }
    if (
      typeof item.id !== "string" ||
      !SAFE_ID.test(item.id) ||
      typeof item.description !== "string" ||
      item.description.trim().length === 0 ||
      item.description.length > 2000
    ) {
      throw new Error("Acceptance criterion is invalid");
    }
    return { id: item.id, description: item.description };
  });
  if (new Set(acceptanceCriteria.map((item) => item.id)).size !== acceptanceCriteria.length) {
    throw new Error("Acceptance criterion IDs must be unique");
  }
  if (!Array.isArray(subtasksValue) || subtasksValue.length === 0 || subtasksValue.length > 40) {
    throw new Error("Model plan must include between 1 and 40 subtasks");
  }
  const subtasks = subtasksValue.map((item) => {
    if (!objectWithExactFields(item, SUBTASK_FIELDS)) {
      throw new Error("Subtask contains unsupported fields");
    }
    if (
      typeof item.id !== "string" ||
      !SAFE_ID.test(item.id) ||
      typeof item.title !== "string" ||
      item.title.trim().length === 0 ||
      item.title.length > 300 ||
      typeof item.description !== "string" ||
      item.description.length > 5000 ||
      typeof item.ownerAgentId !== "string" ||
      item.ownerAgentId.length === 0 ||
      !isStringArray(item.dependsOn, 40) ||
      !isStringArray(item.requiredTools, 64)
    ) {
      throw new Error("Subtask is invalid");
    }
    const requiredTools = item.requiredTools as string[];
    if (
      new Set(requiredTools).size !== requiredTools.length ||
      requiredTools.some((tool) => !context.allowedTools.includes(tool))
    ) {
      throw new Error("Subtask requests a tool not allowed by server policy");
    }
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      ownerAgentId: item.ownerAgentId,
      dependsOn: [...(item.dependsOn as string[])],
      requiredTools,
    };
  });
  if (new Set(subtasks.map((task) => task.id)).size !== subtasks.length) {
    throw new Error("Subtask IDs must be unique");
  }
  const dag = validateTaskDag(subtasks.map(({ id, dependsOn }) => ({ id, dependsOn })));
  if (!dag.valid) throw new Error(`Task dependency graph is invalid: ${dag.reason}`);

  return { goal, acceptanceCriteria, subtasks };
}

export async function validatePlanProposal(
  database: Database,
  runId: string,
  proposal: unknown,
  context: PlanValidationContext,
): Promise<ValidatedPlan> {
  const repositories = createRepositories(database);
  const run = (await repositories.runs.getById(runId));
  if (!run || run.state !== "draft") throw new Error("Only draft runs can receive a plan");
  const plan = normalizeProposal(proposal, context);
  const agents = (await repositories.agents.list());
  const projectAgentIds = new Set(
    agents
      .filter((agent) => agent.projectId === null || agent.projectId === run.projectId)
      .map((agent) => agent.id),
  );
  if (plan.subtasks.some((task) => !projectAgentIds.has(task.ownerAgentId))) {
    throw new Error("Every subtask owner must be an agent in this project");
  }
  if ((await repositories.runPlans.getByRunId(runId))) {
    throw new Error("This run already has a submitted plan");
  }
  return {
    ...plan,
    runId,
    planVersion: run.planVersion,
    baselineCommit: run.baselineCommit,
    subtasks: plan.subtasks.map((task) => ({ ...task, taskId: "" })),
  };
}

export async function proposePlanForApproval(
  database: Database,
  runId: string,
  proposal: unknown,
  context: PlanValidationContext,
) {
  const repositories = createRepositories(database);
  const validatedPlan = (await validatePlanProposal(database, runId, proposal, context));
  const scope: ApprovalScope = {
    planVersion: validatedPlan.planVersion,
    baselineCommit: validatedPlan.baselineCommit,
    setupCommands: [...context.setupCommands],
    verificationCommands: [...context.verificationCommands],
    permissions: [...context.allowedPermissions],
    costLimitMicrounits: context.costLimitMicrounits,
  };
  const taskIds = new Map(validatedPlan.subtasks.map((task) => [task.id, randomUUID()]));
  const approvals = createApprovalService(database, {
    allowedPermissions: context.allowedPermissions,
  });

  const approval = (await approvals.submitForApproval(runId, scope, async (createdApproval) => {
    (await repositories.runPlans.create({
      runId,
      planVersion: validatedPlan.planVersion,
      goal: validatedPlan.goal,
      acceptanceCriteriaJson: JSON.stringify(validatedPlan.acceptanceCriteria),
      setupCommandsJson: JSON.stringify(scope.setupCommands),
      verificationCommandsJson: JSON.stringify(scope.verificationCommands),
      allowedToolsJson: JSON.stringify(context.allowedTools),
      approvalId: createdApproval.id,
      approvalFingerprint: createdApproval.payloadFingerprint,
    }));

    for (const [position, task] of validatedPlan.subtasks.entries()) {
      (await repositories.tasks.create({
        id: taskIds.get(task.id)!,
        runId,
        ownerAgentId: task.ownerAgentId,
        title: task.title,
        state: "queued",
        position,
      }));
    }
    const insertDependency = database.prepare(
      "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)",
    );
    for (const task of validatedPlan.subtasks) {
      for (const dependencyId of task.dependsOn) {
        (await insertDependency.run(taskIds.get(task.id)!, taskIds.get(dependencyId)!));
      }
    }
    (await repositories.events.append({
      runId,
      eventType: "plan.submitted",
      payload: {
        goal: validatedPlan.goal,
        approvalId: createdApproval.id,
        taskCount: validatedPlan.subtasks.length,
        acceptanceCriteriaIds: validatedPlan.acceptanceCriteria.map((item) => item.id),
      },
    }));
  }));

  return {
    approval,
    plan: {
      ...validatedPlan,
      subtasks: validatedPlan.subtasks.map((task) => ({
        ...task,
        taskId: taskIds.get(task.id)!,
      })),
    },
  };
}

export async function selectNextReadyTask(database: Database, runId: string) {
  const repositories = createRepositories(database);
  const run = (await repositories.runs.getById(runId));
  if (!run || run.state !== "running") throw new Error("Only a running run can schedule tasks");
  const tasks = (await repositories.tasks.listForRun(runId));
  if (tasks.some((task) => task.state === "running")) return null;
  const dag = validateTaskDag(
    await Promise.all(tasks.map(async (task) => ({
      id: task.id,
      dependsOn: (await repositories.taskDependencies.listForTask(task.id)).map((dependency) => dependency.dependsOnTaskId),
    }))),
  );
  if (!dag.valid) throw new Error(`Persisted task graph is invalid: ${dag.reason}`);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.state !== "queued") continue;
    const dependencies = await repositories.taskDependencies.listForTask(task.id);
    if (dependencies.every((dependency) => byId.get(dependency.dependsOnTaskId)?.state === "done")) return task;
  }
  return null;
}

export async function setTaskState(
  database: Database,
  taskId: string,
  nextState: "running" | "done" | "failed" | "blocked" | "cancelled",
  actor: string,
): Promise<void> {
  if (actor !== "worker" && actor !== "system") {
    throw new Error("Model output cannot change task state");
  }
  (await withTransaction(database, async () => {
    const repositories = createRepositories(database);
    const task = (await repositories.tasks.getById(taskId));
    if (!task) throw new Error("Task does not exist");
    const run = (await repositories.runs.getById(task.runId));
    if (!run || run.state !== "running") throw new Error("Task updates require a running run");
    const allowed: Record<string, readonly string[]> = {
      queued: ["running", "blocked", "cancelled"],
      running: ["done", "failed", "blocked", "cancelled"],
    };
    if (!allowed[task.state]?.includes(nextState)) {
      throw new Error("Task state transition is not allowed");
    }
    if (nextState === "running" && (await selectNextReadyTask(database, task.runId))?.id !== taskId) {
      throw new Error("Only the next ready task can start; execution must be serial");
    }
    const changed = (await database
      .prepare("UPDATE tasks SET state = $1 WHERE id = $2 AND state = $3")
      .run(nextState, taskId, task.state));
    if (changed.changes !== 1) throw new Error("Task state changed concurrently");
    (await repositories.events.append({
      runId: task.runId,
      eventType: "task.state_changed",
      payload: { taskId, from: task.state, to: nextState, actor },
    }));
  }));
}
