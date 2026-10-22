import { createCodexOAuthClient, type CodexOAuthClientOptions } from "./oauth-client";
import { createCodexDirectRepository, type CodexDirectAccountRecord } from "./repository";
import { openCodexSecret, sealCodexSecret } from "./crypto";
import { CodexDirectError, type CodexModel, type CodexTokens, type DeviceGrant, type DirectAccountView } from "./types";

export interface CodexDirectServiceDependencies extends Omit<CodexOAuthClientOptions, "clock"> {
  repository: ReturnType<typeof createCodexDirectRepository>;
  encryptionKey: Buffer;
  clock: () => number;
}

export interface CodexDirectStartResult {
  providerId: string;
  loginId: string;
  verificationUri: "https://auth.openai.com/codex/device";
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
}

function directAccountView(account: CodexDirectAccountRecord | null, enabled = true): DirectAccountView {
  return {
    enabled,
    providerId: account?.providerId ?? null,
    state: account?.state ?? "not_configured",
    model: account?.model ?? null,
    revision: account?.revision ?? 0,
    inferenceReady: false,
  };
}

function codexAccountAad(providerId: string, revision: number): string {
  return `codex-direct-account:${providerId}:${revision}`;
}

function codexLoginAad(loginId: string, accountRevision: number): string {
  return `codex-direct-login:${loginId}:${accountRevision}`;
}

function positiveClock(value: number): Date {
  const date = new Date(value);
  if (!Number.isSafeInteger(value) || !Number.isFinite(date.getTime()) || value < 0) {
    throw new CodexDirectError("unavailable");
  }
  return date;
}

function isCodexDirectError(error: unknown): error is CodexDirectError {
  return error instanceof CodexDirectError;
}

export function createCodexDirectService(dependencies: CodexDirectServiceDependencies) {
  if (!Buffer.isBuffer(dependencies.encryptionKey) || dependencies.encryptionKey.byteLength !== 32) {
    throw new CodexDirectError("unavailable");
  }
  const oauth = createCodexOAuthClient({
    clientId: dependencies.clientId,
    clientVersion: dependencies.clientVersion,
    fetcher: dependencies.fetcher,
    clock: dependencies.clock,
  });
  const now = () => positiveClock(dependencies.clock());

  async function view(): Promise<DirectAccountView> {
    return directAccountView(await dependencies.repository.readAccount());
  }

  async function releaseAfterFailure(providerId: string, revision: number, leaseId: string): Promise<void> {
    await dependencies.repository.releaseAccountLease(providerId, revision, leaseId).catch(() => false);
  }

  async function readCredential(account: CodexDirectAccountRecord): Promise<CodexTokens> {
    if (account.state !== "connected" || !account.credentialCiphertext) throw new CodexDirectError("needs_login");
    return openCodexSecret<CodexTokens>(
      account.credentialCiphertext,
      dependencies.encryptionKey,
      codexAccountAad(account.providerId, account.revision),
    );
  }

  async function refreshModels(expectedRevision: number, signal: AbortSignal): Promise<{
    models: CodexModel[];
    checkedAt: string;
    account: DirectAccountView;
  }> {
    const current = await dependencies.repository.readAccount();
    if (!current || current.state !== "connected") throw new CodexDirectError("needs_login");
    if (current.revision !== expectedRevision) throw new CodexDirectError("busy");
    let activeAccount = current;
    let activeLease = await dependencies.repository.claimAccount(current.providerId, current.revision, "models", now());
    if (!activeLease) throw new CodexDirectError("busy");
    try {
      let tokens = await readCredential(activeAccount);
      if (tokens.expiresAt <= now().getTime() + 60_000) {
        let rotated: CodexTokens;
        try {
          rotated = await oauth.refresh(tokens, signal);
        } catch (error) {
          if (isCodexDirectError(error) && error.code === "rate_limited") throw error;
          const invalidated = await dependencies.repository.finishAccount(activeAccount.providerId, activeAccount.revision, activeLease.leaseId, {
            state: "needs_login", credentialCiphertext: null, catalog: [], catalogCheckedAt: null, model: null,
          });
          if (!invalidated) throw new CodexDirectError("busy");
          activeLease = null;
          throw new CodexDirectError("needs_login");
        }
        const nextRevision = activeAccount.revision + 1;
        const rotatedCiphertext = sealCodexSecret(rotated, dependencies.encryptionKey,
          codexAccountAad(activeAccount.providerId, nextRevision));
        const stored = await dependencies.repository.finishAccount(activeAccount.providerId, activeAccount.revision, activeLease.leaseId, {
          state: "connected", credentialCiphertext: rotatedCiphertext,
          catalog: activeAccount.catalog, catalogCheckedAt: activeAccount.catalogCheckedAt,
          model: activeAccount.model,
        });
        if (!stored) throw new CodexDirectError("busy");
        activeAccount = (await dependencies.repository.readAccount(activeAccount.providerId))!;
        activeLease = await dependencies.repository.claimAccount(activeAccount.providerId, activeAccount.revision, "models", now());
        if (!activeLease) throw new CodexDirectError("busy");
        activeAccount = (await dependencies.repository.readAccount(activeAccount.providerId))!;
        if (!activeAccount || activeAccount.leaseId !== activeLease.leaseId) throw new CodexDirectError("busy");
        tokens = await readCredential(activeAccount);
      }
      const models = await oauth.models(tokens, signal);
      const checkedAt = now().toISOString();
      const nextRevision = activeAccount.revision + 1;
      const credentialCiphertext = sealCodexSecret(tokens, dependencies.encryptionKey, codexAccountAad(activeAccount.providerId, nextRevision));
      const selectedModel = activeAccount.model && models.some((model) => model.id === activeAccount.model) ? activeAccount.model : null;
      const saved = await dependencies.repository.finishAccount(activeAccount.providerId, activeAccount.revision, activeLease.leaseId, {
        state: "connected", credentialCiphertext, catalog: models, catalogCheckedAt: checkedAt, model: selectedModel,
      });
      if (!saved) throw new CodexDirectError("busy");
      activeLease = null;
      return { models, checkedAt, account: await view() };
    } catch (error) {
      if (activeLease) await releaseAfterFailure(activeAccount.providerId, activeAccount.revision, activeLease.leaseId);
      if (isCodexDirectError(error)) throw error;
      throw new CodexDirectError("unavailable");
    }
  }

  return {
    async start(sessionHash: string, signal: AbortSignal): Promise<CodexDirectStartResult> {
      if (!/^[a-f0-9]{64}$/.test(sessionHash)) throw new CodexDirectError("invalid_request");
      const account = await dependencies.repository.ensureAccount();
      if (account.state === "connected") throw new CodexDirectError("busy");
      const time = now();
      const lease = await dependencies.repository.claimAccount(account.providerId, account.revision, "login", time, 30_000, sessionHash);
      if (!lease) throw new CodexDirectError("busy");
      try {
        const grant = await oauth.start(signal);
        const loginId = lease.leaseId;
        const expiresAt = new Date(Math.min(grant.expiresAt, time.getTime() + 15 * 60_000));
        const grantCiphertext = sealCodexSecret(grant, dependencies.encryptionKey, codexLoginAad(loginId, account.revision));
        const created = await dependencies.repository.startLogin({
          id: loginId,
          providerId: account.providerId,
          ownerSessionHash: sessionHash,
          accountRevision: account.revision,
          grantCiphertext,
          expiresAt,
          nextPollAt: new Date(time.getTime() + grant.intervalSeconds * 1000),
          intervalSeconds: grant.intervalSeconds,
          now: time,
        });
        if (!created) throw new CodexDirectError("busy");
        return {
          providerId: account.providerId,
          loginId,
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: grant.userCode,
          intervalSeconds: grant.intervalSeconds,
          expiresAt: expiresAt.toISOString(),
        };
      } catch (error) {
        if (isCodexDirectError(error)) throw error;
        throw new CodexDirectError("unavailable");
      }
    },

    async poll(loginId: string, sessionHash: string, signal: AbortSignal): Promise<{
      state: "pending" | "connected";
      retryAfterSeconds?: number;
      account?: DirectAccountView;
    }> {
      if (!/^[a-f0-9-]{36}$/i.test(loginId) || !/^[a-f0-9]{64}$/.test(sessionHash)) throw new CodexDirectError("login_expired");
      const time = now();
      const saved = await dependencies.repository.getLoginForOwner(loginId, sessionHash);
      if (!saved || saved.state !== "pending") throw new CodexDirectError("login_expired");
      if (Date.parse(saved.expiresAt) <= time.getTime()) {
        await dependencies.repository.expireLogin(loginId, sessionHash, time);
        throw new CodexDirectError("login_expired");
      }
      const nextPoll = Date.parse(saved.nextPollAt);
      if (nextPoll > time.getTime()) return { state: "pending", retryAfterSeconds: Math.max(1, Math.ceil((nextPoll - time.getTime()) / 1000)) };
      const claimed = await dependencies.repository.claimPoll(loginId, sessionHash, time);
      if (!claimed) throw new CodexDirectError("busy");
      const grant = openCodexSecret<DeviceGrant>(
        claimed.grantCiphertext!, dependencies.encryptionKey, codexLoginAad(claimed.id, claimed.accountRevision),
      );
      try {
        const polled = await oauth.poll(grant, signal);
        if (polled.state === "pending") {
          const nextInterval = polled.slowDown ? claimed.intervalSeconds + 5 : claimed.intervalSeconds;
          if (nextInterval > 120) {
            await dependencies.repository.finishPoll({
              id: claimed.id, pollLeaseId: claimed.pollLeaseId, state: "failed", grantCiphertext: null,
              intervalSeconds: 120, now: time,
            });
            throw new CodexDirectError("rate_limited");
          }
          const nextPollAt = new Date(time.getTime() + nextInterval * 1000);
          const savedPending = await dependencies.repository.finishPoll({
            id: claimed.id, pollLeaseId: claimed.pollLeaseId, state: "pending",
            grantCiphertext: claimed.grantCiphertext, nextPollAt, intervalSeconds: nextInterval, now: time,
          });
          if (!savedPending) throw new CodexDirectError("login_expired");
          return { state: "pending", retryAfterSeconds: nextInterval };
        }
        const tokens = await oauth.exchange(polled.code, polled.verifier, signal);
        const credentialCiphertext = sealCodexSecret(tokens, dependencies.encryptionKey,
          codexAccountAad(claimed.providerId, claimed.accountRevision + 1));
        const savedConnected = await dependencies.repository.finishPoll({
          id: claimed.id, pollLeaseId: claimed.pollLeaseId, state: "connected", grantCiphertext: null,
          intervalSeconds: claimed.intervalSeconds, now: time, connectedCredentialCiphertext: credentialCiphertext,
        });
        if (!savedConnected) throw new CodexDirectError("login_expired");
        return { state: "connected", account: await view() };
      } catch (error) {
        await dependencies.repository.finishPoll({
          id: claimed.id, pollLeaseId: claimed.pollLeaseId, state: "failed", grantCiphertext: null,
          intervalSeconds: Math.min(120, claimed.intervalSeconds), now: now(),
        }).catch(() => false);
        if (isCodexDirectError(error)) throw error;
        throw new CodexDirectError("unavailable");
      }
    },

    async cancel(loginId: string, sessionHash: string): Promise<{ cancelled: true }> {
      const existing = await dependencies.repository.getLoginForOwner(loginId, sessionHash);
      if (!existing) throw new CodexDirectError("login_expired");
      if (existing.state === "pending") await dependencies.repository.cancelLogin(loginId, sessionHash, now());
      return { cancelled: true };
    },

    async account(): Promise<DirectAccountView> {
      return view();
    },

    async disconnect(expectedRevision: number): Promise<DirectAccountView> {
      const account = await dependencies.repository.readAccount();
      if (!account) return directAccountView(null);
      const removed = await dependencies.repository.disconnect(account.providerId, expectedRevision);
      if (!removed) throw new CodexDirectError("busy");
      return view();
    },

    async refreshModels(expectedRevision: number, signal: AbortSignal) {
      return refreshModels(expectedRevision, signal);
    },

    async selectModel(model: string, expectedRevision: number, signal: AbortSignal): Promise<DirectAccountView> {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) throw new CodexDirectError("invalid_request");
      let account = await dependencies.repository.readAccount();
      if (!account || account.state !== "connected") throw new CodexDirectError("needs_login");
      if (account.revision !== expectedRevision) throw new CodexDirectError("busy");
      const catalogAge = account.catalogCheckedAt ? dependencies.clock() - Date.parse(account.catalogCheckedAt) : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(catalogAge) || catalogAge < 0 || catalogAge > 5 * 60_000) {
        await refreshModels(account.revision, signal);
        account = await dependencies.repository.readAccount(account.providerId);
        if (!account || account.state !== "connected") throw new CodexDirectError("needs_login");
      }
      if (!account.catalog.some((entry) => entry.id === model)) throw new CodexDirectError("invalid_request");
      const lease = await dependencies.repository.claimAccount(account.providerId, account.revision, "models", now());
      if (!lease) throw new CodexDirectError("busy");
      try {
        account = (await dependencies.repository.readAccount(account.providerId))!;
        const tokens = await readCredential(account);
        const nextRevision = account.revision + 1;
        const credentialCiphertext = sealCodexSecret(tokens, dependencies.encryptionKey, codexAccountAad(account.providerId, nextRevision));
        const saved = await dependencies.repository.finishAccount(account.providerId, account.revision, lease.leaseId, {
          state: "connected", credentialCiphertext, catalog: account.catalog,
          catalogCheckedAt: account.catalogCheckedAt, model,
        });
        if (!saved) throw new CodexDirectError("busy");
        return view();
      } catch (error) {
        await releaseAfterFailure(account.providerId, account.revision, lease.leaseId);
        if (isCodexDirectError(error)) throw error;
        throw new CodexDirectError("unavailable");
      }
    },
  };
}
