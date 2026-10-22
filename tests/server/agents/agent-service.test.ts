import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentService, AgentServiceError } from "../../../lib/server/agents/agent-service";
import { createRepositories, openDatabase, type Database } from "../../../lib/server/db/database";

const databases: Database[] = [];
const validInput = {
  name: "Nail PM",
  role: "pm",
  projectId: null,
  providerId: null,
  model: null,
  skillIds: ["planning"],
  instructions: "Keep plans testable.",
};

async function setup() {
  const database = await openDatabase(`agent-service-${randomUUID()}`);
  databases.push(database);
  return { database, repositories: createRepositories(database), service: createAgentService(database) };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("agent configuration service", () => {
  it("creates and reads an unbound agent", async () => {
    const { service } = await setup();
    const created = await service.create(validInput);
    expect(created).toMatchObject({ ...validInput, id: expect.any(String), revision: 1 });
    expect(await service.get(created.id)).toEqual(created);
    expect(await service.list()).toEqual([created]);
  });

  it("allows saving a configured Codex model while its provider is unavailable", async () => {
    const { service, repositories } = await setup();
    await repositories.providers.create({
      id: "codex-provider", name: "Codex Subscription", kind: "codex",
      authMode: "subscription_cli", status: "unavailable", model: "configured-model",
    });
    const created = await service.create({
      ...validInput, providerId: "codex-provider", model: "configured-model",
    });
    expect(created).toMatchObject({ providerId: "codex-provider", model: "configured-model" });
  });

  it("rejects unknown references and provider/model mismatches", async () => {
    const { service, repositories } = await setup();
    await repositories.projects.create({ id: "project-1", name: "Nail" });
    await repositories.providers.create({
      id: "p1", name: "Configured", kind: "codex", authMode: "subscription_cli",
      status: "unavailable", model: "model-one",
    });
    await expect(service.create({ ...validInput, projectId: "missing-project" }))
      .rejects.toEqual(expect.objectContaining({ code: "invalid_reference", status: 400 }));
    await expect(service.create({ ...validInput, providerId: "missing-provider", model: "model-one" }))
      .rejects.toEqual(expect.objectContaining({ code: "invalid_reference", status: 400 }));
    await expect(service.create({ ...validInput, providerId: "p1", model: "model-two" }))
      .rejects.toEqual(expect.objectContaining({ code: "model_not_available", status: 400 }));
    await expect(service.create({ ...validInput, providerId: "p1", model: null }))
      .rejects.toEqual(expect.objectContaining({ code: "invalid_input", status: 400 }));
  });

  it("returns safe sorted provider/project options and curated skill metadata", async () => {
    const { service, repositories } = await setup();
    await repositories.projects.create({ id: "project-b", name: "Beta" });
    await repositories.projects.create({ id: "project-a", name: "Alpha" });
    await repositories.providers.create({
      id: "provider-b", name: "Zeta Codex", kind: "codex", authMode: "subscription_cli",
      status: "unavailable", model: "codex-model",
    });
    await repositories.providers.create({
      id: "provider-a", name: "Alpha API", kind: "deepseek", authMode: "api_key",
      status: "ready", model: "deepseek-chat", secretReference: "must-not-leak",
    });
    const options = await service.options();
    expect(options.providers).toEqual([
      { id: "provider-a", name: "Alpha API", kind: "deepseek", status: "ready", models: [{ id: "deepseek-chat", label: "deepseek-chat" }] },
      { id: "provider-b", name: "Zeta Codex", kind: "codex", status: "unavailable", models: [{ id: "codex-model", label: "codex-model" }] },
    ]);
    expect(options.projects).toEqual([{ id: "project-a", name: "Alpha" }, { id: "project-b", name: "Beta" }]);
    expect(options.skills.map(({ id }) => id)).toEqual(["planning", "implementation", "testing", "review"]);
    expect(JSON.stringify(options)).not.toContain("must-not-leak");
    expect(JSON.stringify(options)).not.toContain("instructions");
  });

  it("summarizes stale provider models without silently changing saved agent configuration", async () => {
    const { service, repositories } = await setup();
    await repositories.providers.create({
      id: "codex-provider", name: "Codex", kind: "codex", authMode: "subscription_cli",
      status: "unavailable", model: "model-one",
    });
    await service.create({ ...validInput, providerId: "codex-provider", model: "model-one" });
    await repositories.providers.updateSubscriptionConfiguration("codex-provider", "model-two");
    const summaries = await service.summaries();
    expect(summaries).toEqual([expect.objectContaining({
      name: "Nail PM", providerName: "Codex", providerStatus: "unavailable",
      model: "model-one", modelMatchesProvider: false, skillIds: ["planning"],
    })]);
    expect(JSON.stringify(summaries)).not.toContain("secretReference");
    await expect(service.get("missing-agent")).rejects.toBeInstanceOf(AgentServiceError);
  });

  it("updates with revision compare-and-swap and rejects a stale concurrent edit", async () => {
    const { service } = await setup();
    const created = await service.create(validInput);
    const edited = { ...validInput, name: "PM Updated", skillIds: ["planning", "review"] };
    const outcomes = await Promise.allSettled([
      service.update(created.id, 1, edited),
      service.update(created.id, 1, { ...edited, name: "Stale Name" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const conflict = outcomes.find((outcome) => outcome.status === "rejected");
    expect(conflict?.status === "rejected" ? conflict.reason : null)
      .toMatchObject({ code: "revision_conflict", status: 409 });
    const saved = await service.get(created.id);
    expect(saved.revision).toBe(2);
    expect(saved.createdAt).toBe(created.createdAt);
    expect(saved.name).not.toBe("Stale Name");
  });

  it("blocks edits for nonterminal workspace and old/new project runs", async () => {
    const { service, repositories } = await setup();
    await repositories.projects.create({ id: "project-a", name: "A" });
    await repositories.projects.create({ id: "project-b", name: "B" });
    const agent = await service.create({ ...validInput, projectId: "project-a" });
    await repositories.runs.create({ id: "run-b", projectId: "project-b", state: "interrupted" });
    await expect(service.update(agent.id, 1, { ...validInput, projectId: "project-b" }))
      .rejects.toMatchObject({ code: "agent_in_use", status: 409 });

    const globalAgent = await service.create({ ...validInput, name: "Global" });
    await expect(service.update(globalAgent.id, 1, { ...validInput, name: "Global Updated" }))
      .rejects.toMatchObject({ code: "agent_in_use", status: 409 });
  });

  it("allows editing after terminal runs but refuses deletion when any task keeps history", async () => {
    const { service, repositories } = await setup();
    await repositories.projects.create({ id: "project-1", name: "Project" });
    const agent = await service.create({ ...validInput, projectId: "project-1" });
    await repositories.runs.create({ id: "run-done", projectId: "project-1", state: "done" });
    await repositories.tasks.create({
      id: "historical-task", runId: "run-done", ownerAgentId: agent.id, title: "Archived work",
    });
    const updated = await service.update(agent.id, 1, { ...validInput, projectId: "project-1", name: "Renamed" });
    expect(updated).toMatchObject({ revision: 2, name: "Renamed" });
    await expect(service.delete(agent.id, 2)).rejects.toMatchObject({ code: "agent_referenced", status: 409 });
    expect(await service.get(agent.id)).toMatchObject({ revision: 2, name: "Renamed" });
  });

  it("deletes an unused agent and rejects a stale delete without removing it", async () => {
    const { service } = await setup();
    const agent = await service.create(validInput);
    await expect(service.delete(agent.id, 2)).rejects.toMatchObject({ code: "revision_conflict", status: 409 });
    expect(await service.get(agent.id)).toEqual(agent);
    await expect(service.delete(agent.id, 1)).resolves.toBeUndefined();
    await expect(service.get(agent.id)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

});
