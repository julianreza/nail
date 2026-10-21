import type { Database } from "../db/database";
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
  databaseUrl: string | undefined,
) {
  return async function readProjectRuns(projectId: string, request: Request): Promise<Response> {
    const authorization = await auth.protectedResource(request);
    if (!authorization.ok) return authorization;
    if (!databaseUrl) return json({ error: "Database is not configured" }, 503);

    let database: Database | undefined;
    try {
      database = (await openDatabase(databaseUrl));
      const repositories = createRepositories(database);
      const project = (await repositories.projects.getById(projectId));
      if (!project) return json({ error: "Project not found" }, 404);

      const runs = await Promise.all((await repositories.runs
        .list())
        .filter((run) => run.projectId === projectId)
        .map(async (run) => {
          const plan = (await repositories.runPlans.getByRunId(run.id));
          const tasks = await Promise.all((await repositories.tasks.listForRun(run.id)).map(async (task) => ({
            ...task,
            dependsOn: (await repositories.taskDependencies
              .listForTask(task.id))
              .map((dependency) => dependency.dependsOnTaskId),
          })));
          const approvals = (await repositories.approvals.listForRun(run.id)).map((approval) => ({
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
            qaRounds: (await repositories.qaRounds.listForRun(run.id)),
            qaResults: (await repositories.qaResults
              .list())
              .filter((result) => result.runId === run.id),
          };
        }));

      return json({ project, runs });
    } catch {
      return json({ error: "Unable to read project run data" }, 500);
    } finally {
      (await database?.close());
    }
  };
}
