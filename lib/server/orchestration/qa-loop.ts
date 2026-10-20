import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canTransitionRunState } from "../../domain/run-state";
import { createRepositories } from "../db/repositories";
import { withTransaction } from "../db/database";

export const MAX_QA_FAILURE_ROUNDS = 3;

export interface QaFinding {
  taskId: string;
  summary: string;
}

export interface QaRoundInput {
  runId: string;
  status: "passed" | "failed";
  details: string;
  findings?: QaFinding[];
  verifiedCriteriaIds?: string[];
  verifiedCommands?: string[];
  manualVerificationConfirmed?: boolean;
  manualVerificationActor?: "owner" | "system";
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Stored ${label} is invalid`);
  }
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function recordQaRound(database: DatabaseSync, input: QaRoundInput) {
  if (input.details.length > 5000) throw new Error("QA details are too long");
  return withTransaction(database, () => {
    const repositories = createRepositories(database);
    const run = repositories.runs.getById(input.runId);
    if (!run || run.state !== "awaiting_review") {
      throw new Error("QA may only review a run awaiting review");
    }
    const plan = repositories.runPlans.getByRunId(input.runId);
    if (!plan || plan.planVersion !== run.planVersion) {
      throw new Error("Run plan is missing or stale");
    }
    const criteria = parseJson<Array<{ id: string }>>(
      plan.acceptanceCriteriaJson,
      "acceptance criteria",
    );
    const requiredCommands = parseJson<string[]>(
      plan.verificationCommandsJson,
      "verification command list",
    );
    const existingRounds = repositories.qaRounds.listForRun(input.runId);
    const roundNumber = (existingRounds.at(-1)?.roundNumber ?? 0) + 1;
    const roundId = randomUUID();

    if (input.status === "failed") {
      const findings = input.findings ?? [];
      if (findings.length === 0 || findings.length > 40) {
        throw new Error("Failed QA rounds must include actionable findings");
      }
      const failedRounds = existingRounds.filter((round) => round.status === "failed").length + 1;
      const isLimitReached = failedRounds >= MAX_QA_FAILURE_ROUNDS;
      const nextState = isLimitReached ? "blocked" : "queued";
      if (!canTransitionRunState(run.state, nextState)) {
        throw new Error("Run cannot enter the QA retry state");
      }

      const repairTasks: Array<{ finding: QaFinding; originalTaskId: string; ownerAgentId: string }> = [];
      for (const finding of findings) {
        if (
          typeof finding.taskId !== "string" ||
          typeof finding.summary !== "string" ||
          finding.summary.trim().length === 0 ||
          finding.summary.length > 2000
        ) {
          throw new Error("QA finding is invalid");
        }
        const task = repositories.tasks.getById(finding.taskId);
        if (!task || task.runId !== input.runId || task.state !== "done" || !task.ownerAgentId) {
          throw new Error("QA finding must refer to a completed engineer task");
        }
        const owner = repositories.agents.getById(task.ownerAgentId);
        if (!owner || !/front|back|engineer/i.test(owner.role)) {
          throw new Error("QA repair must route to the task's engineer owner");
        }
        repairTasks.push({ finding, originalTaskId: task.id, ownerAgentId: owner.id });
      }

      repositories.qaRounds.create({
        id: roundId,
        runId: input.runId,
        roundNumber,
        status: "failed",
        details: input.details,
      });
      for (const repair of repairTasks) {
        repositories.qaResults.create({
          id: randomUUID(),
          runId: input.runId,
          taskId: repair.originalTaskId,
          status: "failed",
          details: JSON.stringify({
            kind: "finding",
            roundNumber,
            summary: repair.finding.summary,
          }),
        });
      }

      const repairTaskIds: string[] = [];
      if (!isLimitReached) {
        const nextPosition = repositories.tasks.listForRun(input.runId).reduce(
          (maximum, task) => Math.max(maximum, task.position),
          -1,
        ) + 1;
        const insertDependency = database.prepare(
          "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
        );
        for (const [offset, repair] of repairTasks.entries()) {
          const repairTask = repositories.tasks.create({
            id: randomUUID(),
            runId: input.runId,
            ownerAgentId: repair.ownerAgentId,
            title: `QA fix: ${repair.finding.summary.slice(0, 270)}`,
            state: "queued",
            position: nextPosition + offset,
          });
          insertDependency.run(repairTask.id, repair.originalTaskId);
          repairTaskIds.push(repairTask.id);
        }
      }

      const stateChange = database
        .prepare(
          `UPDATE runs SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ? AND state = 'awaiting_review'`,
        )
        .run(nextState, input.runId);
      if (stateChange.changes !== 1) throw new Error("Run changed while recording QA failure");
      repositories.events.append({
        runId: input.runId,
        eventType: isLimitReached ? "qa.retry_limit_reached" : "qa.repair_tasks_created",
        payload: {
          roundNumber,
          failedFindingCount: repairTasks.length,
          repairTaskIds,
          runState: nextState,
        },
      });
      return { roundNumber, runState: nextState, repairTaskIds, evidenceComplete: false };
    }

    if ((input.findings?.length ?? 0) > 0) {
      throw new Error("A passing QA round cannot include failed findings");
    }
    const verifiedCriteriaIds = input.verifiedCriteriaIds ?? [];
    const verifiedCommands = input.verifiedCommands ?? [];
    if (!isTextList(verifiedCriteriaIds) || !isTextList(verifiedCommands)) {
      throw new Error("QA verification evidence is invalid");
    }
    const knownCriteria = new Set(criteria.map((criterion) => criterion.id));
    if (verifiedCriteriaIds.some((id) => !knownCriteria.has(id))) {
      throw new Error("QA reported an unknown acceptance criterion");
    }
    const knownCommands = new Set(requiredCommands);
    if (verifiedCommands.some((command) => !knownCommands.has(command))) {
      throw new Error("QA reported an unapproved verification command");
    }
    if (
      requiredCommands.length === 0 &&
      input.manualVerificationConfirmed &&
      input.manualVerificationActor !== "owner"
    ) {
      throw new Error("Manual completion verification must come from the owner");
    }

    repositories.qaRounds.create({
      id: roundId,
      runId: input.runId,
      roundNumber,
      status: "passed",
      details: input.details,
    });
    for (const criterion of criteria) {
      repositories.qaResults.create({
        id: randomUUID(),
        runId: input.runId,
        status: verifiedCriteriaIds.includes(criterion.id) ? "verified" : "not-run",
        details: JSON.stringify({ kind: "acceptance", criterionId: criterion.id, roundNumber }),
      });
    }
    for (const command of requiredCommands) {
      repositories.qaResults.create({
        id: randomUUID(),
        runId: input.runId,
        status: verifiedCommands.includes(command) ? "verified" : "not-run",
        details: JSON.stringify({ kind: "verification", command, roundNumber }),
      });
    }
    if (requiredCommands.length === 0) {
      repositories.qaResults.create({
        id: randomUUID(),
        runId: input.runId,
        status: input.manualVerificationConfirmed && input.manualVerificationActor === "owner"
          ? "verified"
          : "not-run",
        details: JSON.stringify({ kind: "manual", roundNumber }),
      });
    }
    const criteriaComplete = criteria.every((criterion) => verifiedCriteriaIds.includes(criterion.id));
    const commandsComplete = requiredCommands.every((command) => verifiedCommands.includes(command));
    const manualComplete = requiredCommands.length > 0 ||
      (input.manualVerificationConfirmed === true && input.manualVerificationActor === "owner");
    repositories.events.append({
      runId: input.runId,
      eventType: "qa.round_passed",
      payload: { roundNumber, criteriaComplete, commandsComplete, manualComplete },
    });
    return {
      roundNumber,
      runState: run.state,
      repairTaskIds: [],
      evidenceComplete: criteriaComplete && commandsComplete && manualComplete,
    };
  });
}

export function finalizeVerifiedRun(
  database: DatabaseSync,
  runId: string,
  options: { manualVerificationConfirmed: boolean; manualVerificationActor?: "owner" | "model" },
): boolean {
  return withTransaction(database, () => {
    const repositories = createRepositories(database);
    const run = repositories.runs.getById(runId);
    const plan = repositories.runPlans.getByRunId(runId);
    if (!run || run.state !== "awaiting_review" || !plan || plan.planVersion !== run.planVersion) {
      return false;
    }
    if (repositories.tasks.listForRun(runId).some((task) => task.state !== "done")) return false;
    const latestRound = repositories.qaRounds.listForRun(runId).at(-1);
    if (!latestRound || latestRound.status !== "passed") return false;

    const criteria = parseJson<Array<{ id: string }>>(plan.acceptanceCriteriaJson, "acceptance criteria");
    const commands = parseJson<string[]>(plan.verificationCommandsJson, "verification command list");
    const qaResults = repositories.qaResults.list().filter((result) => result.runId === runId);
    const evidence = qaResults
      .map((result) => ({ result, details: parseJson<Record<string, unknown>>(result.details, "QA evidence") }))
      .filter(({ details }) => details.roundNumber === latestRound.roundNumber);
    const criteriaVerified = criteria.every((criterion) =>
      evidence.some(({ result, details }) =>
        result.status === "verified" && details.kind === "acceptance" && details.criterionId === criterion.id,
      ),
    );
    const commandsVerified = commands.every((command) =>
      evidence.some(({ result, details }) =>
        result.status === "verified" && details.kind === "verification" && details.command === command,
      ),
    );
    const manualVerified = commands.length > 0 || (
      options.manualVerificationConfirmed &&
      options.manualVerificationActor === "owner" &&
      evidence.some(({ result, details }) => result.status === "verified" && details.kind === "manual")
    );
    if (!criteriaVerified || !commandsVerified || !manualVerified) return false;

    const changed = database
      .prepare(
        `UPDATE runs SET state = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND state = 'awaiting_review' AND plan_version = ? AND baseline_commit IS ?`,
      )
      .run(runId, plan.planVersion, run.baselineCommit);
    if (changed.changes !== 1) return false;
    repositories.events.append({
      runId,
      eventType: "run.verified_complete",
      payload: {
        planVersion: plan.planVersion,
        verifiedCriteriaIds: criteria.map((criterion) => criterion.id),
        verifiedCommands: commands,
        manualVerification: commands.length === 0,
      },
    });
    return true;
  });
}
