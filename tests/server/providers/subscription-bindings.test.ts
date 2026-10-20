import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositories, openDatabase, withTransaction } from "../../../lib/server/db/database";

const directories: string[] = [];

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "nail-subscription-binding-"));
  directories.push(directory);
  return join(directory, "app.sqlite");
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("subscription provider bindings", () => {
  it("backfills only legacy DeepSeek API providers and applies migration idempotently", () => {
    const path = databasePath();
    let database = openDatabase(path);
    const legacyProviders = createRepositories(database).providers;
    legacyProviders.create({
      id: "legacy-deepseek", name: "DeepSeek", kind: "deepseek", status: "ready", authMode: "api_key",
    });
    legacyProviders.create({
      id: "custom-provider", name: "Custom endpoint", status: "ready", authMode: "api_key",
    });
    database.exec(`
      DROP INDEX subscription_provider_kind_unique;
      DELETE FROM schema_migrations WHERE version = 10;
      DROP TABLE provider_account_bindings;
      ALTER TABLE providers DROP COLUMN binding_generation;
      DELETE FROM schema_migrations WHERE version = 9;
      ALTER TABLE providers DROP COLUMN kind;
      DELETE FROM schema_migrations WHERE version = 8;
    `);
    database.close();

    database = openDatabase(path);
    try {
      const migrated = createRepositories(database).providers;
      expect(migrated.getById("legacy-deepseek")?.kind).toBe("deepseek");
      expect(migrated.getById("custom-provider")?.kind).toBeNull();
      expect(database.prepare("SELECT version FROM schema_migrations WHERE version = 8").get()).toEqual({ version: 8 });
    } finally {
      database.close();
    }
  });

  it("stores one account binding per subscription provider and protects binding revisions", () => {
    const database = openDatabase(databasePath());
    const repositories = createRepositories(database);
    try {
      const provider = repositories.providers.create({
        id: "codex-provider",
        name: "Codex Subscription",
        kind: "codex",
        status: "unavailable",
        authMode: "subscription_cli",
      });
      const binding = repositories.accountBindings.create({
        providerId: provider.id,
        bindingId: "codex-owner",
        state: "needs_login",
      });
      expect(binding).toMatchObject({
        providerId: "codex-provider",
        bindingId: "codex-owner",
        state: "needs_login",
        generation: 0,
        revision: 0,
      });
      expect(repositories.accountBindings.updateDiagnostic({
        providerId: provider.id,
        bindingId: binding.bindingId,
        expectedRevision: 0,
        expectedGeneration: 0,
        state: "connected",
        reason: null,
        checkedAt: "2026-10-20T00:00:00.000Z",
      })).toBe(true);
      expect(repositories.accountBindings.getByProviderId(provider.id)).toMatchObject({
        state: "connected",
        revision: 1,
      });
      expect(repositories.accountBindings.updateDiagnostic({
        providerId: provider.id,
        bindingId: binding.bindingId,
        expectedRevision: 0,
        expectedGeneration: 0,
        state: "ready",
        reason: null,
        checkedAt: "2026-10-20T00:00:01.000Z",
      })).toBe(false);
      expect(repositories.accountBindings.delete(provider.id)).toBe(true);
      expect(repositories.accountBindings.getByProviderId(provider.id)).toBeNull();
      expect(repositories.accountBindings.delete(provider.id)).toBe(false);
    } finally {
      database.close();
    }
  });

  it("keeps binding revisions monotonic across disconnect and reattach", () => {
    const database = openDatabase(databasePath());
    const repositories = createRepositories(database);
    try {
      const provider = repositories.providers.create({
        id: "codex-provider", name: "Codex", kind: "codex", status: "unavailable", authMode: "subscription_cli",
      });
      const first = repositories.accountBindings.create({
        providerId: provider.id, bindingId: "codex-owner", state: "connected",
      });
      expect(first.revision).toBe(0);
      expect(first.generation).toBe(0);
      expect(repositories.providers.advanceBindingGeneration(provider.id)).toBe(1);
      expect(repositories.accountBindings.delete(provider.id)).toBe(true);
      const rebound = repositories.accountBindings.create({
        providerId: provider.id, bindingId: "codex-owner", state: "needs_login",
      });
      expect(rebound.revision).toBe(0);
      expect(rebound.generation).toBe(1);
      expect(repositories.accountBindings.updateDiagnostic({
        providerId: provider.id,
        bindingId: first.bindingId,
        expectedRevision: first.revision,
        expectedGeneration: first.generation,
        state: "ready",
        reason: null,
        checkedAt: "2026-10-20T00:00:01.000Z",
      })).toBe(false);
    } finally {
      database.close();
    }
  });

  it("rejects duplicate provider kinds, duplicate bindings and invalid kinds at SQLite", async () => {
    const path = databasePath();
    const databaseA = openDatabase(path);
    const databaseB = openDatabase(path);
    const reposA = createRepositories(databaseA);
    const reposB = createRepositories(databaseB);
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => withTransaction(databaseA, () => reposA.providers.create({
          id: "codex-a", name: "Codex A", kind: "codex", status: "unavailable", authMode: "subscription_cli",
        }))),
        Promise.resolve().then(() => withTransaction(databaseB, () => reposB.providers.create({
          id: "codex-b", name: "Codex B", kind: "codex", status: "unavailable", authMode: "subscription_cli",
        }))),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const winner = reposA.providers.list().find((provider) => provider.kind === "codex")!;
      const other = reposA.providers.create({
        id: "antigravity-a", name: "Antigravity", kind: "antigravity", status: "unavailable", authMode: "subscription_cli",
      });
      reposA.accountBindings.create({ providerId: winner.id, bindingId: "shared", state: "connected" });
      expect(() => reposA.accountBindings.create({
        providerId: other.id, bindingId: "shared", state: "connected",
      })).toThrow();
      expect(() => databaseA.prepare(
        "UPDATE providers SET kind = 'unknown' WHERE id = ?",
      ).run(other.id)).toThrow();
    } finally {
      databaseA.close();
      databaseB.close();
    }
  });
});
