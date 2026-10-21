import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubscriptionConnector } from "../../../lib/domain/subscription-provider";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { EncryptedSecretStore } from "../../../lib/server/providers/secret-store";
import { configureRunUsageBudget } from "../../../lib/server/providers/usage-budget";
import { createProviderRegistry } from "../../../lib/server/providers/provider-registry";

const directories: string[] = [];

async function createDatabase(directory: string) {
  const database = (await openDatabase(join(directory, "app-database")));
  const repositories = createRepositories(database);
  (await repositories.projects.create({ id: "project", name: "Nail" }));
  (await repositories.runs.create({ id: "run", projectId: "project", state: "running" }));
  (await configureRunUsageBudget(database, { runId: "run", maxRequests: 2, maxToolCalls: 0, maxOutputTokens: 100 }));
  return { database, repositories };
}

function subscriptionConnector(): SubscriptionConnector {
  return {
    check: async () => ({
      kind: "codex", state: "ready", reason: null, model: "gpt-codex-model", checkedAt: "2026-10-20T00:00:00Z",
    }),
    cancel: async () => undefined,
    complete: async () => ({
      text: "subscription plan",
      model: "gpt-codex-model",
      usage: { inputTokens: 9, outputTokens: 3 },
      finishReason: "stop",
    }),
  };
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("provider registry text dispatch", () => {
  it("routes by provider kind and never reads a secret store for subscription auth", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nail-provider-registry-"));
    directories.push(directory);
    const { database, repositories } = (await createDatabase(directory));
    const provider = (await repositories.providers.create({
      id: "codex-1",
      name: "Renamed account label",
      kind: "codex",
      status: "ready",
      model: "gpt-codex-model",
      authMode: "subscription_cli",
    }));
    (await repositories.accountBindings.create({ providerId: provider.id, bindingId: "codex-owner", state: "ready" }));
    let connectorCalls = 0;
    const connector = subscriptionConnector();
    const trackedConnector: SubscriptionConnector = {
      ...connector,
      complete: async (input, signal) => {
        connectorCalls += 1;
        return (await connector.complete(input, signal));
      },
    };
    const registry = createProviderRegistry({
      database,
      connector: trackedConnector,
    });
    try {
      await expect(registry.completeText({
        providerId: provider.id,
        runId: "run",
        prompt: "Make a plan",
        maxOutputTokens: 20,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ text: "subscription plan" });
      expect(connectorCalls).toBe(1);
      expect((await repositories.usageRecords.list())).toMatchObject([
        { runId: "run", providerId: provider.id, inputTokens: 9, outputTokens: 3, usageState: "known" },
      ]);
    } finally {
      (await database.close());
    }
  });

  it("preserves DeepSeek routing by stable kind despite a display-name change", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nail-provider-registry-"));
    directories.push(directory);
    const { database, repositories } = (await createDatabase(directory));
    const secretStore = new EncryptedSecretStore(join(directory, "secrets"), Buffer.alloc(32, 8));
    const secretReference = secretStore.put("local-test-api-key");
    const provider = (await repositories.providers.create({
      id: "deepseek-1",
      name: "Owner label",
      kind: "deepseek",
      status: "ready",
      model: "deepseek-chat",
      authMode: "api_key",
      secretReference,
    }));
    let requestCount = 0;
    const registry = createProviderRegistry({
      database,
      secretStore,
      connector: subscriptionConnector(),
      fetcher: async () => {
        requestCount += 1;
        return Response.json({
          id: "completion-1",
          model: "deepseek-chat",
          choices: [{ message: { role: "assistant", content: "deepseek plan", tool_calls: [] }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        });
      },
    });
    try {
      await expect(registry.completeText({
        providerId: provider.id,
        runId: "run",
        prompt: "Make a plan",
        maxOutputTokens: 20,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ text: "deepseek plan", model: "deepseek-chat" });
      expect(requestCount).toBe(1);
      expect((await repositories.usageRecords.list())).toMatchObject([
        { providerId: provider.id, inputTokens: 5, outputTokens: 2, usageState: "known" },
      ]);
    } finally {
      (await database.close());
    }
  });
});
