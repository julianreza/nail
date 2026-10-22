import { randomUUID } from "node:crypto";
import { AGENT_SKILLS } from "../../domain/agent-skills";
import { parseAgentInput, type AgentInput, type AgentOptions, type AgentSummary, type AgentView } from "../../domain/agent";
import { createRepositories, withTransaction, type Database } from "../db/database";

export type AgentServiceErrorCode =
  | "invalid_input"
  | "invalid_reference"
  | "model_not_available"
  | "not_found"
  | "revision_conflict"
  | "agent_in_use"
  | "agent_referenced";

const SERVICE_ERRORS: Record<AgentServiceErrorCode, { status: number; message: string }> = {
  invalid_input: { status: 400, message: "Agent configuration is invalid" },
  invalid_reference: { status: 400, message: "Selected project or provider does not exist" },
  model_not_available: { status: 400, message: "Selected model is not configured for this provider" },
  not_found: { status: 404, message: "Agent was not found" },
  revision_conflict: { status: 409, message: "Agent changed since it was loaded" },
  agent_in_use: { status: 409, message: "Agent cannot be changed while a scoped run is active" },
  agent_referenced: { status: 409, message: "Agent is referenced by saved task history" },
};

export class AgentServiceError extends Error {
  public readonly status: number;

  constructor(public readonly code: AgentServiceErrorCode) {
    const value = SERVICE_ERRORS[code];
    super(value.message);
    this.name = "AgentServiceError";
    this.status = value.status;
  }
}

function parseInput(value: unknown): AgentInput {
  try {
    return parseAgentInput(value);
  } catch {
    throw new AgentServiceError("invalid_input");
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new AgentServiceError("invalid_input");
}

async function hasNonterminalRun(
  repositories: ReturnType<typeof createRepositories>,
  projectIds: readonly (string | null)[],
): Promise<boolean> {
  const runs = await repositories.runs.list();
  const globalScope = projectIds.includes(null);
  const affectedProjects = new Set(projectIds.filter((id): id is string => id !== null));
  return runs.some((run) =>
    !["done", "failed", "cancelled"].includes(run.state) &&
    (globalScope || affectedProjects.has(run.projectId)),
  );
}

function isAgentTaskReferenceError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "23503" &&
    "constraint" in error && error.constraint === "tasks_owner_agent_id_fkey";
}

function compareByName(first: { name: string; id: string }, second: { name: string; id: string }): number {
  return first.name.localeCompare(second.name) || first.id.localeCompare(second.id);
}

export function createAgentService(database: Database) {
  const repositories = createRepositories(database);

  async function validateReferences(input: AgentInput): Promise<void> {
    if (input.projectId && !(await repositories.projects.getById(input.projectId))) {
      throw new AgentServiceError("invalid_reference");
    }
    if (input.providerId === null) return;
    const provider = await repositories.providers.getById(input.providerId);
    if (!provider) throw new AgentServiceError("invalid_reference");
    if (!provider.model || provider.model !== input.model) {
      throw new AgentServiceError("model_not_available");
    }
  }

  return {
    async list(): Promise<AgentView[]> {
      return await repositories.agents.list();
    },

    async get(id: string): Promise<AgentView> {
      const agent = await repositories.agents.getById(id);
      if (!agent) throw new AgentServiceError("not_found");
      return agent;
    },

    async options(): Promise<AgentOptions> {
      const [providers, projects] = await Promise.all([
        repositories.providers.list(),
        repositories.projects.list(),
      ]);
      return {
        providers: providers
          .map((provider) => ({
            id: provider.id,
            name: provider.name,
            kind: provider.kind,
            status: provider.status,
            models: provider.model ? [{ id: provider.model, label: provider.model }] : [],
          }))
          .sort(compareByName),
        projects: projects
          .map(({ id, name }) => ({ id, name }))
          .sort(compareByName),
        skills: AGENT_SKILLS.map(({ id, name, description }) => ({ id, name, description })),
      };
    },

    async summaries(): Promise<AgentSummary[]> {
      const [agents, providers] = await Promise.all([
        repositories.agents.list(),
        repositories.providers.list(),
      ]);
      const providerById = new Map(providers.map((provider) => [provider.id, provider]));
      return agents.map((agent) => {
        const provider = agent.providerId ? providerById.get(agent.providerId) : undefined;
        const unbound = agent.providerId === null && agent.model === null;
        return {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          projectId: agent.projectId,
          providerId: agent.providerId,
          providerName: provider?.name ?? null,
          providerStatus: provider?.status ?? null,
          model: agent.model,
          modelMatchesProvider: unbound || Boolean(provider?.model && provider.model === agent.model),
          skillIds: [...agent.skillIds],
        };
      });
    },

    async create(value: AgentInput): Promise<AgentView> {
      const input = parseInput(value);
      const id = randomUUID();
      return await withTransaction(database, async () => {
        await validateReferences(input);
        return await repositories.agents.create({ id, ...input });
      });
    },

    async update(id: string, revision: number, value: AgentInput): Promise<AgentView> {
      assertRevision(revision);
      const input = parseInput(value);
      return await withTransaction(database, async () => {
        const current = await repositories.agents.getById(id);
        if (!current) throw new AgentServiceError("not_found");
        if (current.revision !== revision) throw new AgentServiceError("revision_conflict");
        await validateReferences(input);
        if (await hasNonterminalRun(repositories, [current.projectId, input.projectId])) {
          throw new AgentServiceError("agent_in_use");
        }
        const updated = await repositories.agents.updateConfiguration({ id, revision, ...input });
        if (!updated) throw new AgentServiceError("revision_conflict");
        return (await repositories.agents.getById(id))!;
      });
    },

    async delete(id: string, revision: number): Promise<void> {
      assertRevision(revision);
      try {
        await withTransaction(database, async () => {
          const current = await repositories.agents.getById(id);
          if (!current) throw new AgentServiceError("not_found");
          if (current.revision !== revision) throw new AgentServiceError("revision_conflict");
          if (await hasNonterminalRun(repositories, [current.projectId])) {
            throw new AgentServiceError("agent_in_use");
          }
          if ((await repositories.tasks.list()).some((task) => task.ownerAgentId === id)) {
            throw new AgentServiceError("agent_referenced");
          }
          if (!(await repositories.agents.deleteIfRevision(id, revision))) {
            throw new AgentServiceError("revision_conflict");
          }
        });
      } catch (error) {
        if (isAgentTaskReferenceError(error)) throw new AgentServiceError("agent_referenced");
        throw error;
      }
    },
  };
}
