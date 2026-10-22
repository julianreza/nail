import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositories, openDatabase, type Database } from "../../../../lib/server/db/database";
import { createCodexDirectRepository } from "../../../../lib/server/providers/codex-direct/repository";

const databases: Database[] = [];
async function databasePair() {
  const identity = `codex-direct-repository-${randomUUID()}`;
  const pair = await Promise.all([openDatabase(identity), openDatabase(identity)]);
  databases.push(...pair);
  return pair;
}
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

describe("Codex direct account persistence", () => {
  it("creates one secret-free unavailable provider and an isolated account row", async () => {
    const [database] = await databasePair();
    const direct = createCodexDirectRepository(database);
    const first = await direct.ensureAccount();
    const again = await direct.ensureAccount();
    const provider = await createRepositories(database).providers.getById(first.providerId);
    expect(again.providerId).toBe(first.providerId);
    expect(first).toMatchObject({ state: "not_configured", revision: 1, credentialCiphertext: null, catalog: [], leaseId: null });
    expect(provider).toMatchObject({
      kind: "codex", authMode: "subscription_oauth", status: "unavailable", model: null,
      secretReference: null, capabilities: [],
    });
    expect(await database.prepare("SELECT relrowsecurity FROM pg_class WHERE oid = 'codex_direct_accounts'::regclass").get())
      .toEqual({ relrowsecurity: true });
    const grants = await database.prepare("SELECT rolname, has_table_privilege(rolname, 'codex_direct_accounts', 'SELECT') AS allowed FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')").all();
    expect(grants.every((row) => row.allowed === false)).toBe(true);
  });

  it("keeps direct OAuth mode separate from the existing CLI secret-free binding mode", async () => {
    const [database] = await databasePair();
    const providers = createRepositories(database).providers;
    await expect(providers.create({
      id: randomUUID(), name: "invalid direct", kind: "codex", authMode: "subscription_oauth",
      status: "unavailable", model: null, secretReference: "secret:bad", capabilities: [],
    })).rejects.toThrow();
    await expect(providers.create({
      id: randomUUID(), name: "ready direct", kind: "codex", authMode: "subscription_oauth",
      status: "ready", model: "gpt-test", capabilities: [],
    })).rejects.toThrow();
    const cli = await providers.create({
      id: randomUUID(), name: "legacy CLI", kind: "codex", authMode: "subscription_cli",
      status: "unavailable", model: "gpt-cli", secretReference: null, capabilities: [],
    });
    expect(cli.authMode).toBe("subscription_cli");
    await expect(createRepositories(database).accountBindings.create({
      providerId: (await createCodexDirectRepository(database).ensureAccount()).providerId,
      bindingId: "codex-owner", state: "needs_login",
    })).rejects.toThrow();
  });

  it("uses compare-and-swap claims and disconnect cannot be overwritten by an old lease", async () => {
    const [firstDb, secondDb] = await databasePair();
    const first = createCodexDirectRepository(firstDb);
    const second = createCodexDirectRepository(secondDb);
    const account = await first.ensureAccount();
    const now = new Date("2026-10-22T00:00:00.000Z");
    const claims = await Promise.all([
      first.claimAccount(account.providerId, account.revision, "models", now),
      second.claimAccount(account.providerId, account.revision, "models", now),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const lease = claims.find(Boolean)!;
    expect(await first.disconnect(account.providerId, account.revision)).toBe(true);
    expect(await first.finishAccount(account.providerId, account.revision, lease.leaseId, {
      state: "connected", credentialCiphertext: "cipher_fixture", catalog: [], catalogCheckedAt: null,
    })).toBe(false);
    const disconnected = await first.readAccount(account.providerId);
    expect(disconnected).toMatchObject({ state: "not_configured", credentialCiphertext: null, model: null, catalog: [], leaseId: null });
    expect(disconnected?.revision).toBe(account.revision + 1);
  });
});
