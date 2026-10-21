import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubscriptionConnector } from "../../../lib/domain/subscription-provider";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { UsageBudgetExceededError, configureRunUsageBudget } from "../../../lib/server/providers/usage-budget";
import { SubscriptionProviderError } from "../../../lib/server/providers/subscription-errors";
import { completeProviderText } from "../../../lib/server/providers/subscription-adapter";

const directories: string[] = [];

async function createContext() {
  const directory = mkdtempSync(join(tmpdir(), "nail-subscription-usage-"));
  directories.push(directory);
  const database = (await openDatabase(join(directory, "app-database")));
  const repos = createRepositories(database);
  (await repos.projects.create({ id: "project", name: "Nail" }));
  (await repos.runs.create({ id: "run", projectId: "project", state: "running" }));
  const provider = (await repos.providers.create({
    id: "codex-provider",
    name: "Codex Subscription",
    kind: "codex",
    status: "ready",
    model: "gpt-codex-model",
    authMode: "subscription_cli",
  }));
  (await repos.accountBindings.create({ providerId: provider.id, bindingId: "codex-owner", state: "ready" }));
  (await configureRunUsageBudget(database, { runId: "run", maxRequests: 1, maxToolCalls: 0, maxOutputTokens: 10 }));
  return { database, repos, provider };
}

function connector(overrides: Partial<SubscriptionConnector> = {}): SubscriptionConnector {
  return {
    check: async () => ({
      kind: "codex", state: "ready", reason: null, model: "gpt-codex-model", checkedAt: "2026-10-20T00:00:00Z",
    }),
    cancel: async () => undefined,
    complete: async () => ({
      text: "NAIL_OK",
      model: "gpt-codex-model",
      usage: { inputTokens: 12, outputTokens: 4 },
      finishReason: "stop",
    }),
    ...overrides,
  };
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("subscription provider usage accounting", () => {
  it("reserves before one connector call and records known usage without a secret store", async () => {
    const { database, repos, provider } = (await createContext());
    let calls = 0;
    const model = connector({ complete: async () => {
      calls += 1;
      return {
        text: "NAIL_OK", model: "gpt-codex-model",
        usage: { inputTokens: 12, outputTokens: 4 }, finishReason: "stop",
      };
    } });
    try {
      await expect(completeProviderText(database, provider.id, "run", "make a plan", 10, new AbortController().signal, model))
        .resolves.toMatchObject({ text: "NAIL_OK", model: "gpt-codex-model" });
      expect(calls).toBe(1);
      expect((await repos.usageRecords.list())).toMatchObject([
        { requestCount: 1, inputTokens: 12, outputTokens: 4, usageState: "known", estimatedCostMicrounits: null },
      ]);
      await expect(completeProviderText(database, provider.id, "run", "again", 10, new AbortController().signal, model))
        .rejects.toBeInstanceOf(UsageBudgetExceededError);
      expect(calls).toBe(1);
    } finally {
      (await database.close());
    }
  });

  it("settles an uncertain failed request conservatively against the reserved output budget", async () => {
    const { database, repos, provider } = (await createContext());
    const model = connector({ complete: async () => { throw new SubscriptionProviderError("unavailable"); } });
    try {
      await expect(completeProviderText(database, provider.id, "run", "make a plan", 10, new AbortController().signal, model))
        .rejects.toMatchObject({ code: "unavailable" });
      expect((await repos.usageRecords.list())).toMatchObject([
        { requestCount: 1, outputTokens: 10, usageState: "unknown", estimatedCostMicrounits: null },
      ]);
    } finally {
      (await database.close());
    }
  });

  it("charges the reserved cap and rejects a provider result that reports excess output", async () => {
    const { database, repos, provider } = (await createContext());
    const model = connector({ complete: async () => ({
      text: "too much",
      model: "gpt-codex-model",
      usage: { inputTokens: 5, outputTokens: 11 },
      finishReason: "stop",
    }) });
    try {
      await expect(completeProviderText(database, provider.id, "run", "make a plan", 10, new AbortController().signal, model))
        .rejects.toBeInstanceOf(UsageBudgetExceededError);
      expect((await repos.usageRecords.list())).toMatchObject([
        { requestCount: 1, outputTokens: 10, usageState: "unknown" },
      ]);
    } finally {
      (await database.close());
    }
  });

  it("does not invoke the connector for a blocked or misbound provider", async () => {
    const { database, repos, provider } = (await createContext());
    let calls = 0;
    const model = connector({ complete: async () => { calls += 1; throw new Error("must not run"); } });
    try {
      (await repos.providers.updateStatus(provider.id, "unavailable"));
      await expect(completeProviderText(database, provider.id, "run", "goal", 5, new AbortController().signal, model))
        .rejects.toMatchObject({ code: "unavailable" });
      (await repos.providers.updateStatus(provider.id, "ready"));
      (await repos.accountBindings.delete(provider.id));
      await expect(completeProviderText(database, provider.id, "run", "goal", 5, new AbortController().signal, model))
        .rejects.toMatchObject({ code: "invalid_binding" });
      expect(calls).toBe(0);
    } finally {
      (await database.close());
    }
  });
});
