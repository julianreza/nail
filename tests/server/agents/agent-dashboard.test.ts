import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createRepositories, openDatabase } from "../../../lib/server/db/database";
import { createDashboardReadHandlers } from "../../../lib/server/dashboard/read-api";
import { createAgentService } from "../../../lib/server/agents/agent-service";

it("returns the saved roster and exact count from the same dashboard snapshot", async () => {
  const databaseUrl = `agent-dashboard-${randomUUID()}`;
  const database = await openDatabase(databaseUrl);
  try {
    const repositories = createRepositories(database);
    await repositories.projects.create({ id: "project-1", name: "Nail" });
    await repositories.providers.create({
      id: "provider-1", name: "Codex Subscription", kind: "codex",
      status: "unavailable", model: "configured-model", authMode: "subscription_cli",
    });
    await repositories.agents.create({
      id: "agent-pm", projectId: "project-1", providerId: "provider-1",
      name: "Planner custom", role: "pm", model: "configured-model", skillIds: ["planning"],
      instructions: "private editor text",
    });
    await repositories.agents.create({
      id: "agent-review", name: "Review custom", role: "review",
      skillIds: ["review"],
    });

    const handlers = createDashboardReadHandlers(
      { protectedResource: async () => Response.json({ authenticated: true }) },
      databaseUrl,
    );
    const request = new Request("https://nail.example/api/overview");
    const overviewResponse = await handlers.overview(request);
    const overview = await overviewResponse.json() as { agentsCount: number; agents: Array<Record<string, unknown>> };
    expect(overviewResponse.headers.get("cache-control")).toBe("no-store");
    expect(overview.agentsCount).toBe(2);
    expect(overview.agents).toEqual([
      {
        id: "agent-pm", name: "Planner custom", role: "pm", projectId: "project-1",
        providerId: "provider-1", providerName: "Codex Subscription", providerStatus: "unavailable",
        model: "configured-model", modelMatchesProvider: true, skillIds: ["planning"],
      },
      {
        id: "agent-review", name: "Review custom", role: "review", projectId: null,
        providerId: null, providerName: null, providerStatus: null,
        model: null, modelMatchesProvider: true, skillIds: ["review"],
      },
    ]);
    expect(JSON.stringify(overview)).not.toContain("private editor text");
    expect(JSON.stringify(overview)).not.toContain("secretReference");

    const agentList = await handlers.agents(new Request("https://nail.example/api/agents"));
    expect(await agentList.json()).toMatchObject([
      { id: "agent-pm", model: "configured-model", skillIds: ["planning"], revision: 1 },
      { id: "agent-review", model: null, skillIds: ["review"], revision: 1 },
    ]);

    const service = createAgentService(database);
    await service.update("agent-pm", 1, {
      name: "Planner renamed", role: "pm", projectId: "project-1", providerId: "provider-1",
      model: "configured-model", skillIds: ["planning"], instructions: "private editor text",
    });
    await service.delete("agent-review", 1);
    const refreshed = await (await handlers.overview(request)).json() as { agentsCount: number; agents: Array<{ id: string; name: string }> };
    expect(refreshed.agentsCount).toBe(1);
    expect(refreshed.agents).toEqual([{ id: "agent-pm", name: "Planner renamed", role: "pm", projectId: "project-1", providerId: "provider-1", providerName: "Codex Subscription", providerStatus: "unavailable", model: "configured-model", modelMatchesProvider: true, skillIds: ["planning"] }]);
  } finally {
    await database.close();
  }
});
