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

function count(database: DatabaseSync, query: string): number {
  const result = database.prepare(query).get() as { total: number };
  return result.total;
}

export function createDashboardReadHandlers(
  auth: AuthGuard,
  databasePath: string | undefined,
) {
  async function read<T>(
    request: Request,
    query: (database: DatabaseSync, repositories: ReturnType<typeof createRepositories>) => T,
  ): Promise<Response> {
    const authorization = await auth.protectedResource(request);
    if (!authorization.ok) return authorization;
    if (!databasePath) {
      return json({ error: "Database is not configured" }, 503);
    }

    let database: DatabaseSync | undefined;
    try {
      database = openDatabase(databasePath);
      return json(query(database, createRepositories(database)));
    } catch {
      return json({ error: "Unable to read application data" }, 500);
    } finally {
      database?.close();
    }
  }

  return {
    overview(request: Request): Promise<Response> {
      return read(request, (database) => ({
        projectsCount: count(database, "SELECT COUNT(*) AS total FROM projects"),
        agentsCount: count(database, "SELECT COUNT(*) AS total FROM agents"),
        activeRunsCount: count(
          database,
          "SELECT COUNT(*) AS total FROM runs WHERE state IN ('running', 'awaiting_review')",
        ),
        queuedRunsCount: count(
          database,
          "SELECT COUNT(*) AS total FROM runs WHERE state = 'queued'",
        ),
        pendingApprovalsCount: count(
          database,
          "SELECT COUNT(*) AS total FROM approvals WHERE decision = 'pending'",
        ),
      }));
    },
    projects(request: Request): Promise<Response> {
      return read(request, (_database, repositories) => repositories.projects.list());
    },
    agents(request: Request): Promise<Response> {
      return read(request, (_database, repositories) => repositories.agents.list());
    },
    tasks(request: Request): Promise<Response> {
      return read(request, (_database, repositories) => repositories.tasks.list());
    },
    approvals(request: Request): Promise<Response> {
      return read(request, (_database, repositories) => repositories.approvals.list());
    },
    providers(request: Request): Promise<Response> {
      return read(request, (_database, repositories) =>
        repositories.providers.list().map((provider) => {
          const binding = repositories.accountBindings.getByProviderId(provider.id);
          return {
            id: provider.id,
            name: provider.name,
            kind: provider.kind,
            status: provider.status,
            model: provider.model,
            authMode: provider.authMode,
            capabilities: provider.capabilities,
            createdAt: provider.createdAt,
            connection: binding
              ? { state: binding.state, reason: binding.reason, checkedAt: binding.checkedAt }
              : null,
          };
        }),
      );
    },
  };
}
