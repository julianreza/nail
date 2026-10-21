import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositories, openDatabase, withTransaction } from "../../../lib/server/db/database";

const directories: string[] = [];

function databaseUrl() {
  const directory = mkdtempSync(join(tmpdir(), "nail-subscription-binding-"));
  directories.push(directory);
  return join(directory, "app-database");
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("subscription provider bindings", () => {
  it("preserves provider kinds and applies PostgreSQL migrations idempotently on reopen", async () => {
    const path = databaseUrl();
    let database = (await openDatabase(path));
    const legacyProviders = createRepositories(database).providers;
    (await legacyProviders.create({
      id: "legacy-deepseek", name: "DeepSeek", kind: "deepseek", status: "ready", authMode: "api_key",
    }));
    (await legacyProviders.create({
      id: "custom-provider", name: "Custom endpoint", status: "ready", authMode: "api_key",
    }));

    (await database.close());

    database = (await openDatabase(path));
    try {
      const migrated = createRepositories(database).providers;
      expect((await migrated.getById("legacy-deepseek"))?.kind).toBe("deepseek");
      expect((await migrated.getById("custom-provider"))?.kind).toBeNull();
      expect((await database.prepare("SELECT version FROM schema_migrations WHERE version = 8").get())).toEqual({ version: 8 });
    } finally {
      (await database.close());
    }
  });

  it("stores one account binding per subscription provider and protects binding revisions", async () => {
    const database = (await openDatabase(databaseUrl()));
    const repositories = createRepositories(database);
    try {
      const provider = (await repositories.providers.create({
        id: "codex-provider",
        name: "Codex Subscription",
        kind: "codex",
        status: "unavailable",
        authMode: "subscription_cli",
      }));
      const binding = (await repositories.accountBindings.create({
        providerId: provider.id,
        bindingId: "codex-owner",
        state: "needs_login",
      }));
      expect(binding).toMatchObject({
        providerId: "codex-provider",
        bindingId: "codex-owner",
        state: "needs_login",
        generation: 0,
        revision: 0,
      });
      expect((await repositories.accountBindings.updateDiagnostic({
        providerId: provider.id,
        bindingId: binding.bindingId,
        expectedRevision: 0,
        expectedGeneration: 0,
        state: "connected",
        reason: null,
        checkedAt: "2026-10-20T00:00:00.000Z",
      }))).toBe(true);
      expect((await repositories.accountBindings.getByProviderId(provider.id))).toMatchObject({
        state: "connected",
        revision: 1,
      });
      expect((await repositories.accountBindings.updateDiagnostic({
        providerId: provider.id,
        bindingId: binding.bindingId,
        expectedRevision: 0,
        expectedGeneration: 0,
        state: "ready",
        reason: null,
        checkedAt: "2026-10-20T00:00:01.000Z",
      }))).toBe(false);
      expect((await repositories.accountBindings.delete(provider.id))).toBe(true);
      expect((await repositories.accountBindings.getByProviderId(provider.id))).toBeNull();
      expect((await repositories.accountBindings.delete(provider.id))).toBe(false);
    } finally {
      (await database.close());
    }
  });

  it("keeps binding revisions monotonic across disconnect and reattach", async () => {
    const database = (await openDatabase(databaseUrl()));
    const repositories = createRepositories(database);
    try {
      const provider = (await repositories.providers.create({
        id: "codex-provider", name: "Codex", kind: "codex", status: "unavailable", authMode: "subscription_cli",
      }));
      const first = (await repositories.accountBindings.create({
        providerId: provider.id, bindingId: "codex-owner", state: "connected",
      }));
      expect(first.revision).toBe(0);
      expect(first.generation).toBe(0);
      expect((await repositories.providers.advanceBindingGeneration(provider.id))).toBe(1);
      expect((await repositories.accountBindings.delete(provider.id))).toBe(true);
      const rebound = (await repositories.accountBindings.create({
        providerId: provider.id, bindingId: "codex-owner", state: "needs_login",
      }));
      expect(rebound.revision).toBe(0);
      expect(rebound.generation).toBe(1);
      expect((await repositories.accountBindings.updateDiagnostic({
        providerId: provider.id,
        bindingId: first.bindingId,
        expectedRevision: first.revision,
        expectedGeneration: first.generation,
        state: "ready",
        reason: null,
        checkedAt: "2026-10-20T00:00:01.000Z",
      }))).toBe(false);
    } finally {
      (await database.close());
    }
  });

  it("rejects duplicate provider kinds, duplicate bindings and invalid kinds at PostgreSQL", async () => {
    const path = databaseUrl();
    const databaseA = (await openDatabase(path));
    const databaseB = (await openDatabase(path));
    const reposA = createRepositories(databaseA);
    const reposB = createRepositories(databaseB);
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(async () => (await withTransaction(databaseA, async () => (await reposA.providers.create({
          id: "codex-a", name: "Codex A", kind: "codex", status: "unavailable", authMode: "subscription_cli",
        }))))),
        Promise.resolve().then(async () => (await withTransaction(databaseB, async () => (await reposB.providers.create({
          id: "codex-b", name: "Codex B", kind: "codex", status: "unavailable", authMode: "subscription_cli",
        }))))),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const winner = (await reposA.providers.list()).find((provider) => provider.kind === "codex")!;
      const other = (await reposA.providers.create({
        id: "antigravity-a", name: "Antigravity", kind: "antigravity", status: "unavailable", authMode: "subscription_cli",
      }));
      (await reposA.accountBindings.create({ providerId: winner.id, bindingId: "shared", state: "connected" }));
      await expect(async () => (await reposA.accountBindings.create({
        providerId: other.id, bindingId: "shared", state: "connected",
      }))).rejects.toThrow();
      await expect(async () => (await databaseA.prepare(
        "UPDATE providers SET kind = 'unknown' WHERE id = $1",
      ).run(other.id))).rejects.toThrow();
    } finally {
      (await databaseA.close());
      (await databaseB.close());
    }
  });
});
