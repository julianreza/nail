import { randomUUID } from "node:crypto";
import { type Database, createRepositories, withTransaction } from "../../db/database";
import type { CodexModel } from "./types";

export type CodexDirectAccountState = "not_configured" | "needs_login" | "connected";
export type CodexDirectLeaseKind = "login" | "refresh" | "models" | "probe";
export type CodexDirectLoginState = "pending" | "connected" | "cancelled" | "expired" | "failed";

export interface CodexDirectAccountRecord {
  providerId: string;
  state: CodexDirectAccountState;
  revision: number;
  credentialCiphertext: string | null;
  catalog: CodexModel[];
  catalogCheckedAt: string | null;
  leaseId: string | null;
  leaseKind: CodexDirectLeaseKind | null;
  leaseUntil: string | null;
  model: string | null;
}

export interface CodexDirectLoginRecord {
  id: string;
  providerId: string;
  ownerSessionHash: string;
  accountRevision: number;
  state: CodexDirectLoginState;
  grantCiphertext: string | null;
  expiresAt: string;
  nextPollAt: string;
  intervalSeconds: number;
  leaseId: string | null;
  leaseUntil: string | null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function accountFromRow(row: Record<string, unknown> | undefined): CodexDirectAccountRecord | null {
  if (!row) return null;
  const catalogValue = typeof row.catalogJson === "string" ? JSON.parse(row.catalogJson) as unknown : row.catalogJson;
  if (!Array.isArray(catalogValue)) throw new Error("Direct Codex catalog storage is invalid");
  return {
    providerId: String(row.providerId),
    state: row.state as CodexDirectAccountState,
    revision: Number(row.revision),
    credentialCiphertext: typeof row.credentialCiphertext === "string" ? row.credentialCiphertext : null,
    catalog: catalogValue as CodexModel[],
    catalogCheckedAt: iso(row.catalogCheckedAt),
    leaseId: typeof row.leaseId === "string" ? row.leaseId : null,
    leaseKind: row.leaseKind as CodexDirectLeaseKind | null,
    leaseUntil: iso(row.leaseUntil),
    model: typeof row.model === "string" ? row.model : null,
  };
}

function loginFromRow(row: Record<string, unknown> | undefined): CodexDirectLoginRecord | null {
  if (!row) return null;
  return {
    id: String(row.id),
    providerId: String(row.providerId),
    ownerSessionHash: String(row.ownerSessionHash),
    accountRevision: Number(row.accountRevision),
    state: row.state as CodexDirectLoginState,
    grantCiphertext: typeof row.grantCiphertext === "string" ? row.grantCiphertext : null,
    expiresAt: iso(row.expiresAt)!,
    nextPollAt: iso(row.nextPollAt)!,
    intervalSeconds: Number(row.intervalSeconds),
    leaseId: typeof row.leaseId === "string" ? row.leaseId : null,
    leaseUntil: iso(row.leaseUntil),
  };
}

const ACCOUNT_SELECT = `SELECT a.provider_id AS "providerId", a.state, a.revision,
  a.credential_ciphertext AS "credentialCiphertext", a.catalog_json AS "catalogJson",
  a.catalog_checked_at AS "catalogCheckedAt", a.lease_id AS "leaseId",
  a.lease_kind AS "leaseKind", a.lease_until AS "leaseUntil", p.model
  FROM codex_direct_accounts a JOIN providers p ON p.id = a.provider_id
  WHERE p.auth_mode = 'subscription_oauth' AND p.kind = 'codex'`;

export function createCodexDirectRepository(database: Database) {
  async function readAccount(providerId?: string): Promise<CodexDirectAccountRecord | null> {
    const row = providerId
      ? await database.prepare(`${ACCOUNT_SELECT} AND a.provider_id = $1`).get(providerId)
      : await database.prepare(`${ACCOUNT_SELECT} ORDER BY a.updated_at DESC LIMIT 1`).get();
    return accountFromRow(row);
  }

  return {
    async ensureAccount(): Promise<CodexDirectAccountRecord> {
      return withTransaction(database, async () => {
        let account = await readAccount();
        if (account) return account;
        const provider = (await createRepositories(database).providers.list()).find((item) =>
          item.kind === "codex" && item.authMode === "subscription_oauth"
        );
        const providerId = provider?.id ?? randomUUID();
        if (!provider) {
          await createRepositories(database).providers.create({
            id: providerId,
            name: "Codex Subscription (langsung)",
            kind: "codex",
            status: "unavailable",
            model: null,
            authMode: "subscription_oauth",
            secretReference: null,
            capabilities: [],
          });
        }
        await database.prepare(
          `INSERT INTO codex_direct_accounts (provider_id, state, revision, credential_ciphertext, catalog_json)
           VALUES ($1, 'not_configured', 1, NULL, '[]'::jsonb)`,
        ).run(providerId);
        account = await readAccount(providerId);
        if (!account) throw new Error("Direct Codex account could not be created");
        return account;
      });
    },

    readAccount,

    async claimAccount(
      providerId: string,
      revision: number,
      kind: CodexDirectLeaseKind,
      now: Date,
      leaseMs = 30_000,
    ): Promise<{ leaseId: string; leaseUntil: string } | null> {
      if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 45_000) {
        throw new Error("Direct Codex lease input is invalid");
      }
      const leaseId = randomUUID();
      const until = new Date(now.getTime() + leaseMs);
      if (!Number.isFinite(until.getTime())) throw new Error("Direct Codex lease input is invalid");
      return withTransaction(database, async () => {
        const current = await readAccount(providerId);
        if (!current || current.revision !== revision) return null;
        if (current.leaseId && current.leaseUntil && Date.parse(current.leaseUntil) > now.getTime()) return null;
        if (current.leaseId && current.leaseKind === "refresh") {
          await database.prepare(
            `UPDATE codex_direct_accounts SET state = 'needs_login', revision = revision + 1,
              credential_ciphertext = NULL, catalog_json = '[]'::jsonb, catalog_checked_at = NULL,
              lease_id = NULL, lease_kind = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE provider_id = $1 AND revision = $2 AND lease_id = $3`,
          ).run(providerId, revision, current.leaseId);
          await database.prepare(
            "UPDATE providers SET model = NULL, status = 'needs_login' WHERE id = $1 AND auth_mode = 'subscription_oauth'",
          ).run(providerId);
          return null;
        }
        const updated = await database.prepare(
          `UPDATE codex_direct_accounts SET lease_id = $1, lease_kind = $2, lease_until = $3,
            updated_at = CURRENT_TIMESTAMP
           WHERE provider_id = $4 AND revision = $5
             AND (lease_id IS NULL OR lease_until <= $6)`,
        ).run(leaseId, kind, until.toISOString(), providerId, revision, now.toISOString());
        return updated.changes === 1 ? { leaseId, leaseUntil: until.toISOString() } : null;
      });
    },

    async finishAccount(
      providerId: string,
      revision: number,
      leaseId: string,
      changes: {
        state: CodexDirectAccountState;
        credentialCiphertext: string | null;
        catalog: CodexModel[];
        catalogCheckedAt: string | null;
        model?: string | null;
      },
    ): Promise<boolean> {
      if (
        !Number.isSafeInteger(revision) || revision < 1 || !leaseId ||
        (changes.state === "connected") !== (changes.credentialCiphertext !== null) ||
        !Array.isArray(changes.catalog) || JSON.stringify(changes.catalog).length > 128 * 1024
      ) throw new Error("Direct Codex account update is invalid");
      return withTransaction(database, async () => {
        const changed = await database.prepare(
          `UPDATE codex_direct_accounts SET state = $1, revision = revision + 1,
            credential_ciphertext = $2, catalog_json = $3::jsonb, catalog_checked_at = $4,
            lease_id = NULL, lease_kind = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE provider_id = $5 AND revision = $6 AND lease_id = $7`,
        ).run(changes.state, changes.credentialCiphertext, JSON.stringify(changes.catalog), changes.catalogCheckedAt,
          providerId, revision, leaseId);
        if (changed.changes !== 1) return false;
        const providerStatus = changes.state === "connected" ? "unavailable" : changes.state === "needs_login" ? "needs_login" : "not_configured";
        await database.prepare(
          `UPDATE providers SET status = $1, model = $2
           WHERE id = $3 AND auth_mode = 'subscription_oauth' AND kind = 'codex'
             AND capabilities_json::jsonb = '[]'::jsonb AND secret_reference IS NULL`,
        ).run(providerStatus, changes.model === undefined ? (changes.state === "connected" ? (await readAccount(providerId))?.model ?? null : null) : changes.model,
          providerId);
        return true;
      });
    },

    async startLogin(input: {
      id: string;
      providerId: string;
      ownerSessionHash: string;
      accountRevision: number;
      grantCiphertext: string;
      expiresAt: Date;
      nextPollAt: Date;
      intervalSeconds: number;
      now: Date;
    }): Promise<boolean> {
      if (
        !input.id || !input.providerId || !/^[a-f0-9]{64}$/.test(input.ownerSessionHash) ||
        !Number.isSafeInteger(input.accountRevision) || input.accountRevision < 1 || !input.grantCiphertext ||
        !Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds < 5 || input.intervalSeconds > 120 ||
        input.expiresAt.getTime() <= input.now.getTime() || input.nextPollAt.getTime() < input.now.getTime()
      ) throw new Error("Direct Codex login is invalid");
      return withTransaction(database, async () => {
        const account = await readAccount(input.providerId);
        if (!account || account.revision !== input.accountRevision || account.state === "connected" ||
          (account.leaseId && account.leaseUntil && Date.parse(account.leaseUntil) > input.now.getTime())) return false;
        await database.prepare(
          `UPDATE codex_direct_logins SET state = 'expired', grant_ciphertext = NULL, lease_id = NULL, lease_until = NULL
           WHERE provider_id = $1 AND state = 'pending' AND expires_at <= $2`,
        ).run(input.providerId, input.now.toISOString());
        const inserted = await database.prepare(
          `INSERT INTO codex_direct_logins
            (id, provider_id, owner_session_hash, account_revision, state, grant_ciphertext,
             expires_at, next_poll_at, interval_seconds)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
        ).run(input.id, input.providerId, input.ownerSessionHash, input.accountRevision, input.grantCiphertext,
          input.expiresAt.toISOString(), input.nextPollAt.toISOString(), input.intervalSeconds);
        if (inserted.changes !== 1) return false;
        const reserved = await database.prepare(
          `UPDATE codex_direct_accounts SET lease_id = $1, lease_kind = 'login', lease_until = $2,
            updated_at = CURRENT_TIMESTAMP
           WHERE provider_id = $3 AND revision = $4 AND state <> 'connected'
             AND (lease_id IS NULL OR lease_until <= $5)`,
        ).run(input.id, input.expiresAt.toISOString(), input.providerId, input.accountRevision, input.now.toISOString());
        if (reserved.changes !== 1) throw new Error("Direct Codex account reservation failed");
        await database.prepare(
          "DELETE FROM codex_direct_logins WHERE provider_id = $1 AND state <> 'pending' AND created_at < $2",
        ).run(input.providerId, new Date(input.now.getTime() - 24 * 60 * 60 * 1000).toISOString());
        return true;
      });
    },

    async claimPoll(id: string, ownerSessionHash: string, now: Date): Promise<(CodexDirectLoginRecord & { pollLeaseId: string }) | null> {
      if (!id || !/^[a-f0-9]{64}$/.test(ownerSessionHash)) return null;
      const pollLeaseId = randomUUID();
      return withTransaction(database, async () => {
        const row = await database.prepare(
          `UPDATE codex_direct_logins SET lease_id = $1, lease_until = $2
           WHERE id = $3 AND owner_session_hash = $4 AND state = 'pending'
             AND expires_at > $5 AND next_poll_at <= $5
             AND (lease_id IS NULL OR lease_until <= $5)
             AND account_revision = (SELECT revision FROM codex_direct_accounts WHERE provider_id = codex_direct_logins.provider_id)
           RETURNING id, provider_id AS "providerId", owner_session_hash AS "ownerSessionHash",
             account_revision AS "accountRevision", state, grant_ciphertext AS "grantCiphertext",
             expires_at AS "expiresAt", next_poll_at AS "nextPollAt", interval_seconds AS "intervalSeconds",
             lease_id AS "leaseId", lease_until AS "leaseUntil"`,
        ).get(pollLeaseId, new Date(now.getTime() + 30_000).toISOString(), id, ownerSessionHash, now.toISOString());
        const login = loginFromRow(row);
        return login ? { ...login, pollLeaseId } : null;
      });
    },

    async finishPoll(input: {
      id: string;
      pollLeaseId: string;
      state: CodexDirectLoginState;
      grantCiphertext: string | null;
      nextPollAt?: Date;
      intervalSeconds: number;
      now: Date;
      connectedCredentialCiphertext?: string;
    }): Promise<boolean> {
      if (!input.id || !input.pollLeaseId || !Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds < 5 || input.intervalSeconds > 120) {
        throw new Error("Direct Codex poll update is invalid");
      }
      if ((input.state === "pending") !== (input.grantCiphertext !== null)) throw new Error("Direct Codex poll update is invalid");
      return withTransaction(database, async () => {
        const row = await database.prepare(
          `UPDATE codex_direct_logins SET state = $1, grant_ciphertext = $2,
            next_poll_at = COALESCE($3, next_poll_at), interval_seconds = $4,
            lease_id = NULL, lease_until = NULL
           WHERE id = $5 AND state = 'pending' AND lease_id = $6 AND expires_at > $7
           RETURNING provider_id AS "providerId", account_revision AS "accountRevision"`,
        ).get(input.state, input.grantCiphertext, input.nextPollAt?.toISOString() ?? null, input.intervalSeconds,
          input.id, input.pollLeaseId, input.now.toISOString());
        if (!row) return false;
        const providerId = String(row.providerId);
        const accountRevision = Number(row.accountRevision);
        if (input.state === "connected") {
          if (!input.connectedCredentialCiphertext) throw new Error("Connected Codex poll must save an encrypted credential");
          const account = await database.prepare(
            `UPDATE codex_direct_accounts SET state = 'connected', credential_ciphertext = $1,
              revision = revision + 1, catalog_json = '[]'::jsonb, catalog_checked_at = NULL,
              lease_id = NULL, lease_kind = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE provider_id = $2 AND revision = $3 AND lease_id = $4 AND lease_kind = 'login'`,
          ).run(input.connectedCredentialCiphertext, providerId, accountRevision, input.id);
          if (account.changes !== 1) throw new Error("Direct Codex account changed during login");
          await database.prepare(
            "UPDATE providers SET status = 'unavailable', model = NULL WHERE id = $1 AND auth_mode = 'subscription_oauth'",
          ).run(providerId);
        } else if (input.state !== "pending") {
          await database.prepare(
            `UPDATE codex_direct_accounts SET lease_id = NULL, lease_kind = NULL, lease_until = NULL
             WHERE provider_id = $1 AND revision = $2 AND lease_id = $3 AND lease_kind = 'login'`,
          ).run(providerId, accountRevision, input.id);
        }
        return true;
      });
    },

    async cancelLogin(id: string, ownerSessionHash: string, now: Date): Promise<boolean> {
      return withTransaction(database, async () => {
        const row = await database.prepare(
          `UPDATE codex_direct_logins SET state = 'cancelled', grant_ciphertext = NULL, lease_id = NULL, lease_until = NULL
           WHERE id = $1 AND owner_session_hash = $2 AND state = 'pending'
           RETURNING provider_id AS "providerId", account_revision AS "accountRevision"`,
        ).get(id, ownerSessionHash);
        if (!row) return false;
        await database.prepare(
          `UPDATE codex_direct_accounts SET lease_id = NULL, lease_kind = NULL, lease_until = NULL,
            updated_at = CURRENT_TIMESTAMP
           WHERE provider_id = $1 AND revision = $2 AND lease_id = $3 AND lease_kind = 'login'`,
        ).run(String(row.providerId), Number(row.accountRevision), id);
        await database.prepare(
          "DELETE FROM codex_direct_logins WHERE provider_id = $1 AND state <> 'pending' AND created_at < $2",
        ).run(String(row.providerId), new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
        return true;
      });
    },

    async disconnect(providerId: string, expectedRevision: number): Promise<boolean> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return false;
      return withTransaction(database, async () => {
        const result = await database.prepare(
          `UPDATE codex_direct_accounts SET state = 'not_configured', revision = revision + 1,
            credential_ciphertext = NULL, catalog_json = '[]'::jsonb, catalog_checked_at = NULL,
            lease_id = NULL, lease_kind = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE provider_id = $1 AND revision = $2`,
        ).run(providerId, expectedRevision);
        if (result.changes !== 1) return false;
        await database.prepare(
          `UPDATE codex_direct_logins SET state = 'cancelled', grant_ciphertext = NULL, lease_id = NULL, lease_until = NULL
           WHERE provider_id = $1 AND state = 'pending'`,
        ).run(providerId);
        await database.prepare(
          "DELETE FROM codex_direct_logins WHERE provider_id = $1 AND state <> 'pending' AND created_at < CURRENT_TIMESTAMP - INTERVAL '24 hours'",
        ).run(providerId);
        await database.prepare(
          "UPDATE providers SET status = 'not_configured', model = NULL WHERE id = $1 AND auth_mode = 'subscription_oauth'",
        ).run(providerId);
        return true;
      });
    },
  };
}
