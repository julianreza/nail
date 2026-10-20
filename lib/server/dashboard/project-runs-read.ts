import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database";
import { createRepositories } from "../db/repositories";

interface AuthGuard {
  protectedResource(request: Request): Promise<Response>;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function createProjectRunsReadHandler(
  auth: AuthGuard,
  databasePath: string | undefined,
) {
  return async function readProjectRuns(projectId: string, request: Request): Promise<Response> {
    const authorization = await auth.protectedResource(request);
    if (!authorization.ok) return authorization;
    if (!databasePath) return json({ error: "Database is not configured" }, 503);

    let database: DatabaseSync | undefined;
    try {
      database = openDatabase(databasePath);
      const repositories = createRepositories(database);
      const project = repositories.projects.getById(projectId);
      if (!project) return json({ error: "Project not found" }, 404);

      const runs = repositories.runs
        .list()
        .filter((run) => run.projectId === projectId)
        .map((run) => {
          const plan = repositories.runPlans.getByRunId(run.id);
          const tasks = repositories.tasks.listForRun(run.id).map((task) => ({
            ...task,
            dependsOn: repositories.taskDependencies
              .listForTask(task.id)
              .map((dependency) => dependency.dependsOnTaskId),
          }));
          const approvals = repositories.approvals.listForRun(run.id).map((approval) => ({
            id: approval.id,
            decision: approval.decision,
            payloadFingerprint: approval.payloadFingerprint,
            planVersion: approval.planVersion,
            baselineCommit: approval.baselineCommit,
            scope: parseJson<Record<string, unknown>>(approval.scopeJson),
            createdAt: approval.createdAt,
          }));
          return {
            ...run,
            plan: plan
              ? {
                  goal: plan.goal,
                  planVersion: plan.planVersion,
                  acceptanceCriteria: parseJson<unknown[]>(plan.acceptanceCriteriaJson),
                  setupCommands: parseJson<string[]>(plan.setupCommandsJson),
                  verificationCommands: parseJson<string[]>(plan.verificationCommandsJson),
                  allowedTools: parseJson<string[]>(plan.allowedToolsJson),
                  approvalFingerprint: plan.approvalFingerprint,
                }
              : null,
            tasks,
            approvals,
            qaRounds: repositories.qaRounds.listForRun(run.id),
            qaResults: repositories.qaResults
              .list()
              .filter((result) => result.runId === run.id),
          };
        });

      return json({ project, runs });
    } catch {
      return json({ error: "Unable to read project run data" }, 500);
    } finally {
      database?.close();
    }
  };
}
