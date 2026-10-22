import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRepositories, openDatabase, type Database } from "../../../../lib/server/db/database";
import { createCodexDirectRepository } from "../../../../lib/server/providers/codex-direct/repository";
import { createCodexDirectService } from "../../../../lib/server/providers/codex-direct/service";
import { sealCodexSecret } from "../../../../lib/server/providers/codex-direct/crypto";
import { catalogFixture, NOW, tokensFixture } from "./fixtures";

const databases: Database[] = [];
async function setupAccount(catalog: unknown = [], model: string | null = null) {
  const database = await openDatabase(`codex-direct-models-${randomUUID()}`);
  databases.push(database);
  const repository = createCodexDirectRepository(database);
  const account = await repository.ensureAccount();
  const value = tokensFixture();
  const tokens = {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAt: NOW + value.expires_in * 1000,
    accountId: "fixture_account",
  };
  const ciphertext = sealCodexSecret(tokens, Buffer.alloc(32, 7), `codex-direct-account:${account.providerId}:2`);
  const catalogRows = Array.isArray(catalog) ? catalog :
    typeof catalog === "object" && catalog !== null && "models" in catalog && Array.isArray(catalog.models) ? catalog.models : [];
  await database.prepare("UPDATE codex_direct_accounts SET state='connected', revision=2, credential_ciphertext=$1, catalog_json=$2::jsonb, catalog_checked_at=$3 WHERE provider_id=$4")
    .run(ciphertext, JSON.stringify(catalogRows), catalogRows.length ? new Date(NOW).toISOString() : null, account.providerId);
  await database.prepare("UPDATE providers SET status='unavailable', model=$1 WHERE id=$2").run(model, account.providerId);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(catalogFixture()), { status: 200 }));
  const service = createCodexDirectService({ repository, encryptionKey: Buffer.alloc(32, 7), clientId: "reviewed-client-id", clientVersion: "1.2.3", fetcher, clock: () => NOW });
  return { database, repository, service, fetcher, account: await repository.readAccount(account.providerId) };
}
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

describe("Codex model discovery and selection", () => {
  it("returns only the fresh account catalog and never changes readiness", async () => {
    const { service, fetcher, account, database } = await setupAccount();
    const result = await service.refreshModels(account!.revision, new AbortController().signal);
    expect(result.models).toEqual([{ id: "fixture-model", label: "Fixture model" }]);
    expect(result.account).toMatchObject({ state: "connected", inferenceReady: false });
    const provider = await createRepositories(database).providers.getById(account!.providerId);
    expect(provider).toMatchObject({ status: "unavailable", capabilities: [] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("clears a saved model removed from a successfully refreshed catalog", async () => {
    const { service, fetcher, account, database } = await setupAccount(catalogFixture(), "hidden-model");
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ models: [
      { slug: "replacement", display_name: "Replacement", visibility: "list", priority: 1 },
    ] }), { status: 200 }));
    const result = await service.refreshModels(account!.revision, new AbortController().signal);
    expect(result.models).toEqual([{ id: "replacement", label: "Replacement" }]);
    expect(result.account.model).toBeNull();
    expect(await createRepositories(database).providers.getById(account!.providerId)).toMatchObject({ model: null, status: "unavailable" });
  });

  it("rejects model choices not present in the last successfully loaded catalog", async () => {
    const { service, account } = await setupAccount(catalogFixture());
    await expect(service.selectModel("invented-model", account!.revision, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("refreshes a stale catalog before saving an exact listed model", async () => {
    const { service, account, fetcher, database, repository } = await setupAccount(catalogFixture(), null);
    await database.prepare("UPDATE codex_direct_accounts SET catalog_checked_at=$1 WHERE provider_id=$2")
      .run(new Date(NOW - 10 * 60_000).toISOString(), account!.providerId);
    const stale = await repository.readAccount(account!.providerId);
    await service.selectModel("fixture-model", stale!.revision, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await service.account()).toMatchObject({ state: "connected", model: "fixture-model", inferenceReady: false });
  });
});
