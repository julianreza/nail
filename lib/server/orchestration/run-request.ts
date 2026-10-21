import { randomUUID } from "node:crypto";
import type { Database } from "../db/database";
import { SUBSCRIPTION_PROVIDER_KINDS } from "../../domain/subscription-provider";
import { createRepositories } from "../db/repositories";
import { configureRunUsageBudget } from "../providers/usage-budget";
import { createApprovalService } from "../runs/approval-service";
import { proposePlanForApproval, type PlanValidationContext } from "./plan-service";

export interface CreatePlanRequest {
  projectId: string;
  providerId: string;
  goal: string;
  setupCommands: string[];
  verificationCommands: string[];
  maxRequests: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  costLimitMicrounits: number;
}

export interface PlanGeneratorInput {
  runId: string;
  providerId: string;
  goal: string;
  baselineCommit: string | null;
  agents: Array<{ id: string; role: string }>;
  allowedTools: readonly string[];
  maxOutputTokens: number;
}

export type PlanGenerator = (input: PlanGeneratorInput) => Promise<unknown>;

export interface RunPlanPolicy {
  allowedTools: readonly string[];
  allowedPermissions: readonly string[];
}

const CREDENTIAL_LIKE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
];

function validateRequest(input: CreatePlanRequest): void {
  if (!input.projectId || !input.providerId) throw new Error("Project and provider are required");
  if (typeof input.goal !== "string" || input.goal.trim().length === 0 || input.goal.length > 5000) {
    throw new Error("Goal must be between 1 and 5000 characters");
  }
  if (CREDENTIAL_LIKE_PATTERNS.some((pattern) => pattern.test(input.goal))) {
    throw new Error("Goal appears to contain a credential; remove it before sending");
  }
  for (const [name, commands] of [
    ["setupCommands", input.setupCommands],
    ["verificationCommands", input.verificationCommands],
  ] as const) {
    if (
      !Array.isArray(commands) ||
      commands.length > 100 ||
      commands.some((command) => typeof command !== "string" || !command.trim() || command.length > 4096)
    ) {
      throw new Error(`${name} is invalid`);
    }
  }
  for (const [name, value, max] of [
    ["maxRequests", input.maxRequests, 1000],
    ["maxToolCalls", input.maxToolCalls, 10000],
    ["maxOutputTokens", input.maxOutputTokens, 32768],
    ["costLimitMicrounits", input.costLimitMicrounits, Number.MAX_SAFE_INTEGER],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new Error(`${name} must be a finite positive integer within the allowed bound`);
    }
  }
}

export async function createRunPlanFromGoal(
  database: Database,
  input: CreatePlanRequest,
  policy: RunPlanPolicy,
  generate: PlanGenerator,
) {
  validateRequest(input);
  const repositories = createRepositories(database);
  const project = (await repositories.projects.getById(input.projectId));
  if (!project) throw new Error("Project does not exist");
  const provider = (await repositories.providers.getById(input.providerId));
  const deepSeekReady = provider?.kind === "deepseek" &&
    provider.status === "ready" && provider.authMode === "api_key" &&
    provider.secretReference !== null && provider.model !== null;
  const subscriptionReady = provider?.kind !== null && provider?.kind !== "deepseek" &&
    provider?.kind !== undefined && SUBSCRIPTION_PROVIDER_KINDS.includes(provider.kind) &&
    provider.status === "ready" && provider.authMode === "subscription_cli" &&
    provider.secretReference === null && provider.model !== null &&
    (await repositories.accountBindings.getByProviderId(provider.id))?.state === "ready";
  if (!provider || (!deepSeekReady && !subscriptionReady)) {
    throw new Error("A ready provider with a verified authentication mode is required to generate a plan");
  }
  if (input.setupCommands.some((command) => command.trim().length === 0) ||
      input.verificationCommands.some((command) => command.trim().length === 0)) {
    throw new Error("Commands must not be blank");
  }

  const runId = randomUUID();
  (await repositories.runs.create({
    id: runId,
    projectId: project.id,
    state: "draft",
    planVersion: 1,
    baselineCommit: project.baselineCommit,
  }));
  (await configureRunUsageBudget(database, {
    runId,
    maxRequests: input.maxRequests,
    maxToolCalls: input.maxToolCalls,
    maxOutputTokens: input.maxOutputTokens,
  }));
  (await repositories.conversations.create({
    id: randomUUID(),
    projectId: project.id,
    runId,
    actor: "owner",
    content: input.goal,
  }));

  const context: PlanValidationContext = {
    allowedTools: [...policy.allowedTools],
    allowedPermissions: [...policy.allowedPermissions],
    setupCommands: [...input.setupCommands],
    verificationCommands: [...input.verificationCommands],
    costLimitMicrounits: input.costLimitMicrounits,
  };

  try {
    const modelProposal = await generate({
      runId,
      providerId: provider.id,
      goal: input.goal,
      baselineCommit: project.baselineCommit,
      agents: (await repositories.agents
        .list())
        .filter((agent) => agent.projectId === null || agent.projectId === project.id)
        .map(({ id, role }) => ({ id, role })),
      allowedTools: context.allowedTools,
      maxOutputTokens: input.maxOutputTokens,
    });
    const planSubmission = (await proposePlanForApproval(database, runId, modelProposal, context));
    (await repositories.conversations.create({
      id: randomUUID(),
      projectId: project.id,
      runId,
      actor: "pm",
      content: JSON.stringify({
        goal: planSubmission.plan.goal,
        acceptanceCriteria: planSubmission.plan.acceptanceCriteria,
        taskCount: planSubmission.plan.subtasks.length,
        approvalId: planSubmission.approval.id,
      }),
    }));
    return { runId, ...planSubmission };
  } catch (error) {
    const run = (await repositories.runs.getById(runId));
    if (run?.state === "draft") {
      const approvals = createApprovalService(database, {
        allowedPermissions: policy.allowedPermissions,
      });
      (await approvals.transitionRun(runId, "failed", "system"));
      (await repositories.events.append({
        runId,
        eventType: "plan.generation_failed",
        payload: { errorType: error instanceof Error ? error.name : "UnknownError" },
      }));
    }
    throw error;
  }
}
