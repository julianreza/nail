import { type Database, openDatabase, withTransaction } from "../db/database";
import { createRepositories } from "../db/repositories";
import { createAgentService } from "../agents/agent-service";
import { createCodexDirectRepository } from "../providers/codex-direct/repository";

interface AuthGuard {
  protectedResource(request: Request): Promise<Response>;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function count(database: Database, query: string): Promise<number> {
  const result = (await database.prepare(query).get()) as { total: number };
  return result.total;
}

export function createDashboardReadHandlers(
  auth: AuthGuard,
  databaseUrl: string | undefined,
) {
  async function read<T>(
    request: Request,
    query: (database: Database, repositories: ReturnType<typeof createRepositories>) => T | Promise<T>,
  ): Promise<Response> {
    const authorization = await auth.protectedResource(request);
    if (!authorization.ok) return authorization;
    if (!databaseUrl) {
      return json({ error: "Database is not configured" }, 503);
    }

    let database: Database | undefined;
    try {
      database = (await openDatabase(databaseUrl));
      return json(await query(database, createRepositories(database)));
    } catch {
      return json({ error: "Unable to read application data" }, 500);
    } finally {
      (await database?.close());
    }
  }

  return {
    overview(request: Request): Promise<Response> {
      return read(request, async (database) => withTransaction(database, async () => {
        const agents = await createAgentService(database).summaries();
        return {
          projectsCount: await count(database, "SELECT COUNT(*) AS total FROM projects"),
          agentsCount: agents.length,
          agents,
          activeRunsCount: await count(
            database,
            "SELECT COUNT(*) AS total FROM runs WHERE state IN ('running', 'awaiting_review')",
          ),
          queuedRunsCount: await count(database, "SELECT COUNT(*) AS total FROM runs WHERE state = 'queued'"),
          pendingApprovalsCount: await count(database, "SELECT COUNT(*) AS total FROM approvals WHERE decision = 'pending'"),
        };
      }));
    },
    projects(request: Request): Promise<Response> {
      return read(request, async (_database, repositories) => (await repositories.projects.list()));
    },
    agents(request: Request): Promise<Response> {
      return read(request, async (database) => await createAgentService(database).list());
    },
    tasks(request: Request): Promise<Response> {
      return read(request, async (_database, repositories) => (await repositories.tasks.list()));
    },
    approvals(request: Request): Promise<Response> {
      return read(request, async (_database, repositories) => (await repositories.approvals.list()));
    },
    providers(request: Request): Promise<Response> {
      return read(request, async (database, repositories) => {
        const directRepository = createCodexDirectRepository(database);
        return Promise.all((await repositories.providers.list()).map(async (provider) => {
          const direct = provider.authMode === "subscription_oauth"
            ? await directRepository.readAccount(provider.id)
            : null;
          const binding = provider.authMode === "subscription_cli"
            ? await repositories.accountBindings.getByProviderId(provider.id)
            : null;
          return {
            id: provider.id,
            name: provider.name,
            kind: provider.kind,
            status: provider.status,
            model: provider.model,
            authMode: provider.authMode,
            capabilities: provider.capabilities,
            createdAt: provider.createdAt,
            connection: direct
              ? { state: direct.state, reason: null, checkedAt: direct.catalogCheckedAt }
              : binding
                ? { state: binding.state, reason: binding.reason, checkedAt: binding.checkedAt }
                : provider.authMode === "subscription_oauth"
                  ? { state: "not_configured", reason: null, checkedAt: null }
                  : null,
          };
        }));
      });
    },
  };
}
