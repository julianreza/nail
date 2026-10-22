This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Owner authentication setup

There is no public signup. Create the owner credentials locally:

1. Run `node scripts/hash-owner-password.mjs` in an interactive terminal and copy its `OWNER_PASSWORD_HASH=...` output.
2. Run `node scripts/generate-session-secret.mjs` and copy its `SESSION_SECRET=...` output.
3. Put both values in the ignored `.env.local` file and set `APP_ORIGIN=http://localhost:3000` for local development (use the exact HTTPS origin in production).
4. Run `bun run dev` and open `http://localhost:3000`; the root page requires a valid owner session.

Keep `.env.local` private. The password hash and session secret are never returned to the browser. Login sessions expire after 8 hours and are revoked on logout; restarting the web process invalidates active sessions. Login attempts are rate-limited in the web process.

## Docker runtime

Build the explicit `app` and `connector` Docker targets and run the disposable integration check with `node scripts/docker-runtime-smoke.mjs`; see [Docker runtime](docs/docker-runtime.md) for commands, secret mounts, storage and isolation boundaries. These images package the control plane and private connector, not a production-ready autonomous worker.

## API provider secret storage

The server-side provider adapter reads encrypted API keys through `EncryptedSecretStore`; keys are not stored in PostgreSQL or returned to the browser/sandbox. Before configuring a provider, set `NAIL_SECRET_DIR` to a private persistent directory and create a separate 32-byte key with `node scripts/generate-encryption-key.mjs`; keep that key in server-only runtime configuration (a mounted secret for the app container), never in an image or an untrusted execution container. The Providers page can configure one DeepSeek API-key provider. Nail checks the key against DeepSeek's `/models` endpoint before saving; the selected model must be returned by that request. Keys are encrypted and stored separately from PostgreSQL, and neither the key nor its secret reference is returned to the browser. Local automated tests use a stubbed provider response; live credentials have not been tested.

The Providers page supports administrator-managed subscription CLI bindings and an experimental, owner-only Codex ChatGPT connection that does not require a CLI installation. The direct path is disabled by default (`NAIL_CODEX_DIRECT_ENABLED=0`); enable it only after an OpenAI OAuth-client/backend permission and compatibility review, and supply `NAIL_CODEX_DIRECT_CLIENT_ID` plus `NAIL_CODEX_DIRECT_CLIENT_VERSION` from that review. Credentials are encrypted in PostgreSQL with the existing server-only `NAIL_SECRET_ENCRYPTION_KEY`; device login and model-list access are not inference readiness. Codex direct and CLI provider rows are separate. Both remain unavailable to the production orchestrator: subscription inference is blocked until a genuinely enforceable output budget and security review are complete. Do not use a fixture, source inspection, or saved account as evidence of a live login/model call. The CLI path's setup remains documented in `docs/providers/codex-cli-oauth.md`; the direct experimental path and opt-in smoke check are documented in `docs/providers/codex-direct-oauth.md`.

## Supabase PostgreSQL persistence

Server data uses async `pg` through a server-only `DATABASE_URL`. Copy `.env.example` to your ignored `.env.local`, then supply the PostgreSQL connection string from your own Supabase project's Connect dialog. Use the direct endpoint or session pooler, not the transaction pooler, with the database-owning login. Never prefix the URL with `NEXT_PUBLIC_`, pass it to the private provider connector/sandbox, or use a Supabase browser/service-role API key as a database password.

Remote connections require certificate-verified TLS, including when the URL says `sslmode=require`. If your endpoint uses a private CA, mount its trusted certificate and set `DATABASE_CA_CERT_PATH`; do not disable verification. Plaintext is allowed only for loopback local PostgreSQL. See [PostgreSQL operations](docs/postgresql.md) for setup, migrations, connection limits, and backup guidance.

`await openDatabase(url)` initializes lazily on the server and applies versioned schema migrations under a PostgreSQL transaction/advisory lock. All repositories and consumers are async. Multi-repository mutations reserve one connection through commit/rollback; a transaction-scoped global lock preserves Nail's serial queue, approval, task and usage-budget invariants across web/worker processes. Tables use native constraints and timestamps, and Supabase API roles have no access to owner data. Builds require no database credentials or connectivity. There is no old-data import or local-file persistence fallback; this is a fresh database cutover.

### Checks with disposable PostgreSQL

```sh
bun run test:postgres  # starts and removes a uniquely named local PostgreSQL 17 Docker container
bun run lint
bun run build         # no DATABASE_URL needed
```

Alternatively explicitly set `NAIL_TEST_DATABASE_URL` to a disposable PostgreSQL database and run `bun run test`. Tests create/drop isolated schemas and must never target production or an unknown Supabase project. `test:postgres` overrides any inherited test URL with its own local container. The opt-in real-database regressions cover concurrent migrations, async rollback/connection ownership, queue claims, approval decisions, and budget reservations. Vitest and ESLint exclude sibling `.worktrees` rather than running/checking their stale copies. The separate live sandbox test remains opt-in.

## Sandbox status

The sandbox adapter accepts only an already-approved command list and uses a local rootless Docker daemon with cgroup v2 CPU, memory, and PID controls, network `none`, a non-root UID, a read-only baseline, and no secret/control-plane mounts. Defaults are 1 CPU, 768 MiB RAM, 128 PIDs, and a 15-minute command timeout. Any missing or ineffective control disables sandbox start. `createSandboxTaskExecutor` bridges the worker callback to provider tool calls and sandbox execution, with per-step approval/lease checks and awaited teardown. This callback is not launched automatically by the web app; target VPS validation is still outstanding.

## Orchestration implementation status

Project detail pages read stored plans, task dependencies, QA rounds, and pending approvals. Approval mutations require an owner session, an exact same-origin request, and the reviewed payload fingerprint. Domain services validate plans and serialize task starts. The bounded task loop supports only exact approved `run_command` calls; it records command results, rejects duplicate call IDs, checks the global lease before each step, and never marks a run verified based on a model summary. Any non-zero sandbox command blocks its task even if the model claims success. The executor saves checkpoints and returns `awaiting_review`, not `done`. PM lease scheduling, live provider setup, automatic QA backed by trusted evidence, full file-editing tools, and final patch delivery remain unfinished.

Run `NAIL_LIVE_SANDBOX=1 bun run test -- tests/sandbox/tool-loop-live.test.ts` to opt into the real rootless Docker integration test using the already-installed local `alpine:3.20` image (override with `NAIL_SANDBOX_PROBE_IMAGE`). It does not pull images or contact an AI provider; only its model replies are fixtures. Without opt-in, this test is skipped.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
