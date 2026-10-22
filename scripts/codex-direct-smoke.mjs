#!/usr/bin/env bun
import { pathToFileURL } from "node:url";

const USAGE = "Usage: bun scripts/codex-direct-smoke.mjs --allow-live --provider <UUID>";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function blocked(reason) {
  output({ state: "blocked", reason });
  process.exitCode = 2;
  throw new Error("CODEX_DIRECT_SMOKE_EXIT");
}

function parseArguments(args) {
  let allowLive = false;
  let providerId = null;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") {
      if (args.length !== 1) return { help: false, allowLive, providerId: null };
      help = true;
    } else if (arg === "--allow-live" && !allowLive) {
      allowLive = true;
    } else if (arg === "--provider" && providerId === null && args[index + 1]) {
      providerId = args[index + 1];
      index += 1;
    } else {
      return { help: false, allowLive, providerId: null };
    }
  }
  return { help, allowLive, providerId };
}

function decodeKey(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const key = Buffer.from(value, "base64url");
  return key.byteLength === 32 && key.toString("base64url") === value ? key : null;
}

async function runLive(providerId) {
  const clientId = process.env.NAIL_CODEX_DIRECT_CLIENT_ID;
  const clientVersion = process.env.NAIL_CODEX_DIRECT_CLIENT_VERSION;
  const databaseUrl = process.env.DATABASE_URL;
  const key = decodeKey(process.env.NAIL_SECRET_ENCRYPTION_KEY);
  if (
    process.env.NAIL_CODEX_DIRECT_ENABLED !== "1" || !clientId || clientId.trim() !== clientId ||
    !/^[\x21-\x7e]{1,200}$/.test(clientId) || /\s/.test(clientId) ||
    !clientVersion || !/^\d+\.\d+\.\d+$/.test(clientVersion) || !databaseUrl || !key
  ) blocked("not_configured");

  const [{ openDatabase, createRepositories }, { createCodexDirectRepository }, { createCodexDirectService }, { openCodexSecret, sealCodexSecret }, { probeCodexText }, { CodexDirectError }] = await Promise.all([
    import("../lib/server/db/database"),
    import("../lib/server/providers/codex-direct/repository"),
    import("../lib/server/providers/codex-direct/service"),
    import("../lib/server/providers/codex-direct/crypto"),
    import("../lib/server/providers/codex-direct/text-transport"),
    import("../lib/server/providers/codex-direct/types"),
  ]);

  const database = await openDatabase(databaseUrl);
  const controller = new AbortController();
  let lease = null;
  let account = null;
  let probeStarted = false;
  try {
    const providers = createRepositories(database);
    const provider = await providers.providers.getById(providerId);
    if (!provider || provider.kind !== "codex" || provider.authMode !== "subscription_oauth" ||
      provider.secretReference !== null || provider.status === "ready" || provider.capabilities.length !== 0) blocked("provider_not_found");
    const directRepository = createCodexDirectRepository(database);
    account = await directRepository.readAccount(providerId);
    if (!account || account.state !== "connected" || !account.credentialCiphertext || !account.model) blocked("account_not_ready");

    const service = createCodexDirectService({
      repository: directRepository, encryptionKey: key, clientId, clientVersion, fetcher: fetch, clock: Date.now,
    });
    await service.refreshModels(account.revision, controller.signal);
    account = await directRepository.readAccount(providerId);
    if (!account || account.state !== "connected" || !account.credentialCiphertext || !account.model ||
      !account.catalog.some((model) => model.id === account.model)) blocked("model_not_selected");

    lease = await directRepository.claimAccount(providerId, account.revision, "probe", new Date(), 45_000);
    if (!lease) blocked("account_busy");
    account = await directRepository.readAccount(providerId);
    if (!account || account.state !== "connected" || !account.credentialCiphertext || !account.model || account.leaseId !== lease.leaseId) {
      blocked("account_changed");
    }
    const tokens = openCodexSecret(account.credentialCiphertext, key, `codex-direct-account:${providerId}:${account.revision}`);
    probeStarted = true;
    const result = await probeCodexText({
      tokens,
      model: account.model,
      prompt: "Reply with exactly NAIL_OK",
      signal: controller.signal,
    }, { fetcher: fetch });
    if (result.text !== "NAIL_OK") {
      await directRepository.releaseAccountLease(providerId, account.revision, lease.leaseId);
      lease = null;
      output({ state: "failed", model: account.model, usageKnown: result.usage.inputTokens !== null && result.usage.outputTokens !== null });
      process.exitCode = 2;
      return;
    }
    const nextRevision = account.revision + 1;
    const credentialCiphertext = sealCodexSecret(tokens, key, `codex-direct-account:${providerId}:${nextRevision}`);
    const settled = await directRepository.finishAccount(providerId, account.revision, lease.leaseId, {
      state: "connected", credentialCiphertext, catalog: account.catalog,
      catalogCheckedAt: account.catalogCheckedAt, model: account.model,
    });
    if (!settled) blocked("account_changed");
    lease = null;
    output({ state: "passed", model: account.model, usageKnown: result.usage.inputTokens !== null && result.usage.outputTokens !== null });
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof Error && error.message === "CODEX_DIRECT_SMOKE_EXIT") return;
    if (probeStarted && lease && account) {
      const invalidated = await directRepository.finishAccount(providerId, account.revision, lease.leaseId, {
        state: "needs_login", credentialCiphertext: null, catalog: [], catalogCheckedAt: null, model: null,
      }).catch(() => false);
      if (invalidated) lease = null;
    }
    if (lease && account) await directRepository.releaseAccountLease(providerId, account.revision, lease.leaseId).catch(() => false);
    const reason = error instanceof CodexDirectError ? error.code : "unavailable";
    output({ state: "failed", reason, model: account?.model ?? null, usageKnown: false });
    process.exitCode = 2;
  } finally {
    controller.abort();
    await database.close();
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }
  if (!args.allowLive) {
    output({ state: "opt_in_required" });
    process.exitCode = 2;
    return;
  }
  if (!args.providerId || !UUID.test(args.providerId)) {
    output({ state: "blocked", reason: "invalid_provider_id" });
    process.exitCode = 2;
    return;
  }
  try {
    await runLive(args.providerId);
  } catch (error) {
    if (error instanceof Error && error.message === "CODEX_DIRECT_SMOKE_EXIT") return;
    output({ state: "failed", reason: "unavailable", model: null, usageKnown: false });
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
