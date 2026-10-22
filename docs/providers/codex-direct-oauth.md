# Experimental direct ChatGPT OAuth for Codex (no CLI)

This is an **experimental, opt-in, owner-only** Codex connection path. The owner completes a device-code login in a browser opened from Nail; Nail does not install or execute Codex CLI/App Server. The official Codex runtime is not needed by this path.

This does **not** establish that OpenAI permits a third-party service to reuse a Codex OAuth client or backend endpoint. The integration remains disabled until an operator verifies the required client registration/permission and the exact protocol compatibility. The open-source client implementations are technical references only—not authorization or a stability promise. No OAuth, device-code, model-catalog, or inference request is made by automated tests.

## Hard limits

- The direct connection feature defaults off. Without all reviewed runtime configuration below, GET `/api/providers/codex-direct/account` returns `enabled: false`; mutation routes fail closed.
- A successful sign-in and model catalog produce connection state `connected`, but provider status stays `unavailable`, capabilities remain empty, and `inferenceReady` is always `false`.
- The production provider registry explicitly rejects `subscription_oauth` with `budget_unenforceable`. Do not interpret the private smoke probe, byte caps, rate limits, or synthetic tests as proof that a strict output-token ceiling is enforced. PM/engineer/QA agent execution stays blocked.
- Device-code sign-in can be disabled by the account/workspace. If it is unavailable, do not switch to API-key billing, paste a token, scrape browser cookies, use a personal CLI cache, or spoof a Codex client identity.
- Models are projected from the account's current catalog. Nail does not ship guessed model names or expose vendor instructions from catalog entries. Selection is not a live inference test.

## Required review and server configuration

Before enabling, the deployment owner must review whether Nail may use the selected OAuth client and Codex backend protocol. This has not been verified for the current production service. Do not fill in a client ID from another application as an assumed Nail registration.

After that review, configure these **server-only** values in the Nail app runtime (not the browser or connector):

```text
NAIL_CODEX_DIRECT_ENABLED=1
NAIL_CODEX_DIRECT_CLIENT_ID=<operator-reviewed client ID>
NAIL_CODEX_DIRECT_CLIENT_VERSION=<reviewed major.minor.patch compatibility version>
NAIL_SECRET_ENCRYPTION_KEY=<existing 32-byte base64url runtime key>
DATABASE_URL=<Nail PostgreSQL URL>
```

The default `.env.example` leaves the feature disabled and client/version blank. It does not contain or invent an upstream client ID. `NAIL_SECRET_ENCRYPTION_KEY` is the existing application encryption key; keep it in a private mounted secret, separate from the database backup. Do not place any of these values in `NEXT_PUBLIC_*`, the connector container, a sandbox, source control, or chat.

The current production Compose configuration is not changed by this feature. Do not deploy/enable it until the owner approves the client policy and private runtime egress, database migration, backups, and security review. Automated tests use only local/disposable PostgreSQL and stubbed Fetch responses.

## Owner connection flow

1. Sign in to Nail as the owner and open **Providers → Codex Subscription — tanpa CLI**.
2. Click **Hubungkan ChatGPT**. Nail starts a device-code flow and displays a one-time code plus a link to the fixed official page `https://auth.openai.com/codex/device`.
3. Open that page yourself and enter the code only if you initiated this request in Nail. Never post the code, screen capture, token, account ID, or `auth.json` in Discord or a shared log.
4. Nail makes short, bounded poll requests. When login completes, it reads the account back, then requests the model catalog. Choose an entry from the returned dropdown and save it; Nail checks the exact selected model against the current catalog and reads back the saved account/model.
5. The card reports **Akun terhubung; penggunaan agent belum diaktifkan**. This is expected: the direct account is not inference-ready.

The browser does not send OAuth tokens to Nail. Nail encrypts the access/refresh token envelope before PostgreSQL persistence; the plaintext token and account routing ID are not included in HTTP projections. The one-time device grant is also encrypted while pending and bound to the initiating Nail session. Polling is owner-authenticated, same-origin, no-store, interval-bounded, and expires after at most 15 minutes. No browser localStorage/sessionStorage or background OAuth polling is used.

## Routes and model discovery

The owner UI uses these same-origin endpoints:

- `GET /api/providers/codex-direct/account`
- `POST /api/providers/codex-direct/login/start`
- `POST /api/providers/codex-direct/login/poll`
- `POST /api/providers/codex-direct/login/cancel`
- `POST /api/providers/codex-direct/models`
- `POST /api/providers/codex-direct/model`
- `DELETE /api/providers/codex-direct/account`

Mutations require a valid Nail owner session, exact `APP_ORIGIN`, JSON content type, strict body schemas, and bounded request size. They return `Cache-Control: no-store`; the code-bearing start response also sets `Referrer-Policy: no-referrer`. All upstream hosts/paths are fixed in code, TLS verification remains on, redirects are rejected, and vendor errors are reduced to fixed safe diagnostics.

The model dropdown uses the authenticated Codex catalog; it does not call the public OpenAI API model-list endpoint. Catalog errors or unsupported response schemas fail closed. Do not add a fallback model list or return upstream instructions.

## Storage, disconnect, and backups

The OAuth provider uses `auth_mode=subscription_oauth`, separate from the legacy `subscription_cli` binding. Secret references remain null. A dedicated PostgreSQL migration creates direct-account/login tables with AES-256-GCM ciphertext, purpose/row/revision-bound AAD, RLS enabled, and Supabase API roles revoked. Only the trusted server database owner can read/write these tables.

Protect `NAIL_SECRET_ENCRYPTION_KEY` as carefully as a credential. Restoring encrypted PostgreSQL backups also requires the matching key. Rotating or losing the key without an explicit re-encryption plan makes stored Codex credentials unrecoverable.

**Putuskan koneksi** erases Nail's encrypted credential/catalog, cancels local pending login state, and invalidates in-flight revisions. It does not claim to revoke the provider-side ChatGPT session; use the account's official security/session controls for that. Logging out of Nail is separate from disconnecting the provider.

The legacy CLI binding path remains behind **Codex CLI lama (opsional)** and is stored as a distinct `subscription_cli` provider. Do not copy, migrate, or silently replace an existing CLI binding when adding a direct account.

## Private acceptance probe (may consume subscription quota)

Automated tests never call OpenAI. A live probe is separate owner authorization and may consume subscription quota. Run only against a private preview with reviewed configuration and an owner-approved account/model:

```sh
bun scripts/codex-direct-smoke.mjs --allow-live --provider <provider-UUID>
```

The script sends exactly one text-only `Reply with exactly NAIL_OK` request through the direct Codex backend. It prints only a sanitized result (`state`, selected model, whether usage totals were returned); it never prints prompt output, token values, device codes, account IDs, raw error bodies, or database URL. Without `--allow-live`, it exits 2 with `{"state":"opt_in_required"}` and does not import server runtime code or access the database/network. With opt-in but no feature configuration, it exits 2 with a safe `not_configured` state.

A successful probe still does **not** enable orchestration. It does not prove a hard token cap. Production agent inference needs a separate reviewed design that satisfies Nail's finite-output budget and tool-isolation requirements.

## Verification status

Synthetic tests cover device login protocol parsing, bounded HTTP, encrypted storage, database constraints/concurrency, session binding, model projection, fail-closed registry routing, and SSE tool rejection. These are not evidence of a real OpenAI login, account entitlement, live catalog, backend permission, stable protocol, or successful model call. No live account action has been performed by this implementation work.

## References

- [Codex authentication](https://developers.openai.com/codex/auth.md): subscription vs API-key distinction and device login prerequisites.
- [Codex App Server](https://developers.openai.com/codex/app-server.md): official product-integrations approach, distinct from this no-CLI direct protocol.
- [Pi direct OAuth source](https://github.com/badlogic/pi-mono/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/ai/src/auth/oauth/openai-codex.ts) and [direct transport](https://github.com/badlogic/pi-mono/blob/58c0b02ce552adab76014e7ed712ab7981359aa8/packages/ai/src/api/openai-codex-responses.ts): code-review references, not vendor approval.
