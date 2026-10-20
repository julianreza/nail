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

function createContext() {
  const directory = mkdtempSync(join(tmpdir(), "nail-subscription-usage-"));
  directories.push(directory);
  const database = openDatabase(join(directory, "app.sqlite"));
  const repos = createRepositories(database);
  repos.projects.create({ id: "project", name: "Nail" });
  repos.runs.create({ id: "run", projectId: "project", state: "running" });
  const provider = repos.providers.create({
    id: "codex-provider",
    name: "Codex Subscription",
    kind: "codex",
    status: "ready",
    model: "gpt-codex-model",
    authMode: "subscription_cli",
  });
  repos.accountBindings.create({ providerId: provider.id, bindingId: "codex-owner", state: "ready" });
  configureRunUsageBudget(database, { runId: "run", maxRequests: 1, maxToolCalls: 0, maxOutputTokens: 10 });
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
    const { database, repos, provider } = createContext();
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
      expect(repos.usageRecords.list()).toMatchObject([
        { requestCount: 1, inputTokens: 12, outputTokens: 4, usageState: "known", estimatedCostMicrounits: null },
      ]);
      await expect(completeProviderText(database, provider.id, "run", "again", 10, new AbortController().signal, model))
        .rejects.toBeInstanceOf(UsageBudgetExceededError);
      expect(calls).toBe(1);
    } finally {
      database.close();
    }
  });

  it("settles an uncertain failed request conservatively against the reserved output budget", async () => {
    const { database, repos, provider } = createContext();
    const model = connector({ complete: async () => { throw new SubscriptionProviderError("unavailable"); } });
    try {
      await expect(completeProviderText(database, provider.id, "run", "make a plan", 10, new AbortController().signal, model))
        .rejects.toMatchObject({ code: "unavailable" });
      expect(repos.usageRecords.list()).toMatchObject([
        { requestCount: 1, outputTokens: 10, usageState: "unknown", estimatedCostMicrounits: null },
      ]);
    } finally {
      database.close();
    }
  });

  it("charges the reserved cap and rejects a provider result that reports excess output", async () => {
    const { database, repos, provider } = createContext();
    const model = connector({ complete: async () => ({
      text: "too much",
      model: "gpt-codex-model",
      usage: { inputTokens: 5, outputTokens: 11 },
      finishReason: "stop",
    }) });
    try {
      await expect(completeProviderText(database, provider.id, "run", "make a plan", 10, new AbortController().signal, model))
        .rejects.toBeInstanceOf(UsageBudgetExceededError);
      expect(repos.usageRecords.list()).toMatchObject([
        { requestCount: 1, outputTokens: 10, usageState: "unknown" },
      ]);
    } finally {
      database.close();
    }
  });

  it("does not invoke the connector for a blocked or misbound provider", async () => {
    const { database, repos, provider } = createContext();
    let calls = 0;
    const model = connector({ complete: async () => { calls += 1; throw new Error("must not run"); } });
    try {
      repos.providers.updateStatus(provider.id, "unavailable");
      await expect(completeProviderText(database, provider.id, "run", "goal", 5, new AbortController().signal, model))
        .rejects.toMatchObject({ code: "unavailable" });
      repos.providers.updateStatus(provider.id, "ready");
      repos.accountBindings.delete(provider.id);
      await expect(completeProviderText(database, provider.id, "run", "goal", 5, new AbortController().signal, model))
        .rejects.toMatchObject({ code: "invalid_binding" });
      expect(calls).toBe(0);
    } finally {
      database.close();
    }
  });
});
