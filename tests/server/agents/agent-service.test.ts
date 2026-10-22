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
});
