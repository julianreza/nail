import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Database } from "../../../../lib/server/db/database";
import { createCodexDirectRepository } from "../../../../lib/server/providers/codex-direct/repository";
import { createCodexDirectService } from "../../../../lib/server/providers/codex-direct/service";
import { openCodexSecret, sealCodexSecret } from "../../../../lib/server/providers/codex-direct/crypto";
import { NOW, tokensFixture } from "./fixtures";

const databases: Database[] = [];
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
async function connectedFixture(fetcher: typeof fetch, expiry = NOW + 30_000) {
  const identity = `codex-direct-refresh-${randomUUID()}`;
  const [database, second] = await Promise.all([openDatabase(identity), openDatabase(identity)]);
  databases.push(database, second);
  const repository = createCodexDirectRepository(database);
  const secondRepository = createCodexDirectRepository(second);
  const account = await repository.ensureAccount();
  const fixture = tokensFixture();
  const tokens = { accessToken: fixture.access_token, refreshToken: fixture.refresh_token, expiresAt: expiry, accountId: "fixture_account" };
  const ciphertext = sealCodexSecret(tokens, Buffer.alloc(32, 7), `codex-direct-account:${account.providerId}:2`);
  await database.prepare("UPDATE codex_direct_accounts SET state='connected', revision=2, credential_ciphertext=$1 WHERE provider_id=$2")
    .run(ciphertext, account.providerId);
  await database.prepare("UPDATE providers SET status='unavailable', model='fixture-model' WHERE id=$1").run(account.providerId);
  const makeService = (repo: typeof repository) => createCodexDirectService({
    repository: repo,
    encryptionKey: Buffer.alloc(32, 7),
    clientId: "reviewed-client-id",
    clientVersion: "1.2.3",
    fetcher,
    clock: () => NOW,
  });
  return { database, repository, secondRepository, account: await repository.readAccount(account.providerId), service: makeService(repository), secondService: makeService(secondRepository), tokens };
}
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

describe("Codex direct token refresh", () => {
  it("refreshes within the expiry skew and commits rotation before fetching models", async () => {
    let finishCatalog!: (response: Response) => void;
    let markCatalogStarted!: () => void;
    const catalogStarted = new Promise<void>((resolve) => { markCatalogStarted = resolve; });
    const rotated = { ...tokensFixture(), refresh_token: "rotated_refresh_fixture", expires_in: 3600 };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(rotated))
      .mockImplementationOnce(() => {
        markCatalogStarted();
        return new Promise((resolve) => { finishCatalog = resolve; });
      });
    const { service, repository, account, tokens } = await connectedFixture(fetcher);
    const pending = service.refreshModels(account!.revision, new AbortController().signal);
    await catalogStarted;
    const persisted = await repository.readAccount(account!.providerId);
    expect(persisted).toMatchObject({ revision: account!.revision + 1, state: "connected" });
    const savedTokens = openCodexSecret<{ refreshToken: string }>(
      persisted!.credentialCiphertext!, Buffer.alloc(32, 7),
      `codex-direct-account:${account!.providerId}:${persisted!.revision}`,
    );
    expect(savedTokens.refreshToken).toBe("rotated_refresh_fixture");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain("grant_type=refresh_token");
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain(tokens.refreshToken);
    finishCatalog(json({ models: [{ slug: "fixture-model", display_name: "Fixture model", visibility: "list", priority: 1 }] }));
    await expect(pending).resolves.toMatchObject({ models: [{ id: "fixture-model", label: "Fixture model" }] });
  });

  it("does not refresh tokens that remain valid beyond the expiry skew", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ models: [] }));
    const { service, account } = await connectedFixture(fetcher, NOW + 3_600_000);
    await service.refreshModels(account!.revision, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain("/models?");
  });

  it("serializes refresh across database connections", async () => {
    let finishRefresh!: (response: Response) => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => {
        markRefreshStarted();
        return new Promise((resolve) => { finishRefresh = resolve; });
      })
      .mockResolvedValueOnce(json({ models: [] }));
    const { service, secondService, account } = await connectedFixture(fetcher);
    const first = service.refreshModels(account!.revision, new AbortController().signal);
    await refreshStarted;
    await expect(secondService.refreshModels(account!.revision, new AbortController().signal)).rejects.toMatchObject({ code: "busy" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    finishRefresh(json({ ...tokensFixture(), refresh_token: "rotated_refresh_fixture" }));
    await expect(first).resolves.toMatchObject({ models: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("clears credentials and selected model after invalid_grant", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "invalid_grant" }, 400));
    const { service, repository, account, database } = await connectedFixture(fetcher);
    await expect(service.refreshModels(account!.revision, new AbortController().signal)).rejects.toMatchObject({ code: "needs_login" });
    expect(await repository.readAccount(account!.providerId)).toMatchObject({ state: "needs_login", credentialCiphertext: null, catalog: [], model: null });
    expect(await database.prepare("SELECT model, status FROM providers WHERE id=$1").get(account!.providerId)).toEqual({ model: null, status: "needs_login" });
  });

  it("requires reconnect after an uncertain refresh transport failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network fixture with secret"));
    const { service, repository, account } = await connectedFixture(fetcher);
    await expect(service.refreshModels(account!.revision, new AbortController().signal)).rejects.toMatchObject({ code: "needs_login" });
    expect(await repository.readAccount(account!.providerId)).toMatchObject({ state: "needs_login", credentialCiphertext: null, model: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
