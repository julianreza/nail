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

The server-side provider adapter reads encrypted API keys through `EncryptedSecretStore`; keys are not stored in SQLite or returned to the browser/sandbox. Before configuring a provider, set `NAIL_SECRET_DIR` to a private persistent directory and create a separate 32-byte key with `node scripts/generate-encryption-key.mjs`; keep that key in server-only runtime configuration (a mounted secret for the app container), never in an image or an untrusted execution container. The Providers page can configure one DeepSeek API-key provider. Nail checks the key against DeepSeek's `/models` endpoint before saving; the selected model must be returned by that request. Keys are encrypted and stored separately from SQLite, and neither the key nor its secret reference is returned to the browser. Local automated tests use a stubbed provider response; live credentials have not been tested.

The Providers page also shows owner-managed subscription account bindings for Antigravity, Codex, and Claude. The local connector is started separately with `bun run providers:connector`; set `NAIL_CONNECTOR_SOCKET` and `NAIL_CONNECTOR_BINDINGS_FILE` in its environment and follow `docs/providers/subscription-accounts.md`. Current account adapters are fail-closed: CLIs are not installed on the development host, Claude policy is unverified, and no subscription adapter is enabled for plan generation until authentication, tool isolation, and output-budget controls are verified. Do not treat a saved binding or fixture test as a successful vendor login or live model request.

## SQLite persistence

Server data uses the built-in `node:sqlite` driver, verified with Bun 1.4.3 and the installed Node runtime. Set `NAIL_DATABASE_PATH` to an absolute SQLite file path on persistent storage (for example, `/var/lib/nail/orchestrator.sqlite`). `openDatabase(path)` creates the file's parent directory, enables WAL and foreign keys, applies versioned migrations, and restricts the database file to owner read/write (`0600`). Do not use `:memory:` for application data. API keys and provider auth tokens are not stored in this database.

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
