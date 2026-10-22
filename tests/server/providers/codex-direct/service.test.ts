import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Database } from "../../../../lib/server/db/database";
import { createCodexDirectRepository } from "../../../../lib/server/providers/codex-direct/repository";
import { createCodexDirectService } from "../../../../lib/server/providers/codex-direct/service";
import { tokensFixture, catalogFixture, NOW } from "./fixtures";

const databases: Database[] = [];
const accountSession = "a".repeat(64);
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
async function setup(fetcher: typeof fetch, clock = () => NOW) {
  const database = await openDatabase(`codex-direct-service-${randomUUID()}`);
  databases.push(database);
  const repository = createCodexDirectRepository(database);
  const service = createCodexDirectService({
    repository,
    encryptionKey: Buffer.alloc(32, 7),
    clientId: "reviewed-client-id",
    clientVersion: "1.2.3",
    fetcher,
    clock,
  });
  return { database, repository, service };
}
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

describe("Codex direct owner login lifecycle", () => {
  it("starts a session-bound login and never exposes vendor credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ device_auth_id: "device_123", user_code: "ABCD-EFGH", interval: 5 }));
    const { service, repository } = await setup(fetcher);
    const started = await service.start(accountSession, new AbortController().signal);
    expect(started).toMatchObject({ verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", intervalSeconds: 5 });
    expect(JSON.stringify(started)).not.toContain("device_123");
    expect(JSON.stringify(started)).not.toContain("access_token");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const account = await service.account();
    expect(account).toMatchObject({ enabled: true, state: "not_configured", inferenceReady: false });
    const row = await repository.readAccount(started.providerId);
    expect(row?.credentialCiphertext).toBeNull();
  });

  it("does not poll early and completes device OAuth while keeping provider unavailable", async () => {
    let now = NOW;
    const tokenFixture = tokensFixture();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ device_auth_id: "device_123", user_code: "ABCD-EFGH", interval: 5 }))
      .mockResolvedValueOnce(json({ error: "deviceauth_authorization_pending" }, 403))
      .mockResolvedValueOnce(json({ authorization_code: "auth_code", code_verifier: "pkce_verifier" }))
      .mockResolvedValueOnce(json(tokenFixture))
      .mockResolvedValueOnce(json(catalogFixture()));
    const { service, repository, database } = await setup(fetcher, () => now);
    const started = await service.start(accountSession, new AbortController().signal);
    const early = await service.poll(started.loginId, accountSession, new AbortController().signal);
    expect(early).toMatchObject({ state: "pending", retryAfterSeconds: 5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 5_000;
    const waiting = await service.poll(started.loginId, accountSession, new AbortController().signal);
    expect(waiting).toMatchObject({ state: "pending" });
    now += 5_000;
    const connected = await service.poll(started.loginId, accountSession, new AbortController().signal);
    expect(connected).toMatchObject({ state: "connected", account: { state: "connected", inferenceReady: false, model: null } });
    expect(JSON.stringify(connected)).not.toContain(tokenFixture.access_token);
    expect(JSON.stringify(connected)).not.toContain(tokenFixture.refresh_token);
    const account = await service.account();
    expect(account).toMatchObject({ providerId: started.providerId, state: "connected", inferenceReady: false, model: null });
    const catalog = await service.refreshModels(account.revision, new AbortController().signal);
    expect(catalog.models).toEqual([{ id: "fixture-model", label: "Fixture model" }]);
    const selected = await service.selectModel("fixture-model", catalog.account.revision);
    expect(selected).toMatchObject({ providerId: started.providerId, state: "connected", inferenceReady: false, model: "fixture-model" });
    await expect(service.selectModel("not-in-catalog", selected.revision)).rejects.toMatchObject({ code: "invalid_request" });
    const provider = await (await import("../../../../lib/server/db/repositories")).createRepositories(database).providers.getById(started.providerId);
    expect(provider).toMatchObject({ status: "unavailable", authMode: "subscription_oauth", capabilities: [], model: "fixture-model", secretReference: null });
    const privateRow = await repository.readAccount(started.providerId);
    expect(privateRow?.credentialCiphertext).not.toContain(tokenFixture.access_token);
  });

  it("binds login polling to the initiating Nail session", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ device_auth_id: "device_123", user_code: "ABCD-EFGH", interval: 5 }));
    const { service } = await setup(fetcher);
    const started = await service.start(accountSession, new AbortController().signal);
    await expect(service.poll(started.loginId, "b".repeat(64), new AbortController().signal)).rejects.toMatchObject({ code: "login_expired" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("permits only one vendor poll for concurrent browser poll requests", async () => {
    let now = NOW;
    let finishPoll!: (response: Response) => void;
    let markPollStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => { markPollStarted = resolve; });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ device_auth_id: "device_123", user_code: "ABCD-EFGH", interval: 5 }))
      .mockImplementationOnce(() => {
        markPollStarted();
        return new Promise((resolve) => { finishPoll = resolve; });
      });
    const { service } = await setup(fetcher, () => now);
    const started = await service.start(accountSession, new AbortController().signal);
    now += 5_000;
    const first = service.poll(started.loginId, accountSession, new AbortController().signal);
    await pollStarted;
    await expect(service.poll(started.loginId, accountSession, new AbortController().signal)).rejects.toMatchObject({ code: "busy" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    finishPoll(json({ error: "deviceauth_authorization_pending" }, 403));
    await expect(first).resolves.toMatchObject({ state: "pending" });
  });

  it("expires and erases an abandoned device grant", async () => {
    let now = NOW;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ device_auth_id: "device_123", user_code: "ABCD-EFGH", interval: 5 }));
    const { service, repository } = await setup(fetcher, () => now);
    const started = await service.start(accountSession, new AbortController().signal);
    now += 16 * 60_000;
    await expect(service.poll(started.loginId, accountSession, new AbortController().signal)).rejects.toMatchObject({ code: "login_expired" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await repository.readAccount(started.providerId)).toMatchObject({ state: "not_configured", leaseId: null, credentialCiphertext: null });
  });

  it("does not allow a delayed exchange to reconnect after disconnect", async () => {
    let finishExchange!: (response: Response) => void;
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => { markExchangeStarted = resolve; });
    let now = NOW;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ device_auth_id: "device_123", user_code: "ABCD-EFGH", interval: 5 }))
      .mockResolvedValueOnce(json({ authorization_code: "auth_code", code_verifier: "pkce_verifier" }))
      .mockImplementationOnce(() => {
        markExchangeStarted();
        return new Promise((resolve) => { finishExchange = resolve; });
      });
    const { service } = await setup(fetcher, () => now);
    const started = await service.start(accountSession, new AbortController().signal);
    now += 5_000;
    const checking = service.poll(started.loginId, accountSession, new AbortController().signal);
    await exchangeStarted;
    const current = await service.account();
    await service.disconnect(current.revision);
    finishExchange(json(tokensFixture()));
    await expect(checking).rejects.toMatchObject({ code: "login_expired" });
    expect(await service.account()).toMatchObject({ state: "not_configured", inferenceReady: false, model: null });
  });
});
