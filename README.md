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

## API provider secret storage

The server-side provider adapter reads encrypted API keys through `EncryptedSecretStore`; keys are not stored in SQLite or returned to the browser/sandbox. Before configuring a provider, set `NAIL_SECRET_DIR` to a private persistent directory and create a separate 32-byte key with `node scripts/generate-encryption-key.mjs`; keep that key in server-only environment configuration, never in a container. The Providers page can configure one DeepSeek API-key provider. Nail checks the key against DeepSeek's `/models` endpoint before saving; the selected model must be returned by that request. Keys are encrypted and stored separately from SQLite, and neither the key nor its secret reference is returned to the browser. Local automated tests use a stubbed provider response; live credentials have not been tested.

## SQLite persistence

Server data uses the built-in `node:sqlite` driver, verified with Bun 1.4.3 and the installed Node runtime. Set `NAIL_DATABASE_PATH` to an absolute SQLite file path on persistent storage (for example, `/var/lib/nail/orchestrator.sqlite`). `openDatabase(path)` creates the file's parent directory, enables WAL and foreign keys, applies versioned migrations, and restricts the database file to owner read/write (`0600`). Do not use `:memory:` for application data. API keys and provider auth tokens are not stored in this database.

## Sandbox status

The sandbox adapter accepts only an already-approved command list and uses a local rootless Docker daemon with cgroup v2 CPU, memory, and PID controls, network `none`, a non-root UID, a read-only baseline, and no secret/control-plane mounts. Defaults are 1 CPU, 768 MiB RAM, 128 PIDs, and a 15-minute command timeout. Any missing or ineffective control disables sandbox start. The adapter is not wired into the worker yet, and the target VPS has not been validated; do not treat agent execution as production-ready.

## Orchestration implementation status

Project detail pages read stored plans, task dependencies, QA rounds, and pending approvals. Approval mutations require an owner session, an exact same-origin request, and the reviewed payload fingerprint. Domain services validate plans and serialize task starts; QA tests exercise repair routing and completion gates using fixtures. These are foundations, not a working autonomous PM/engineer/QA pipeline: the model/tool loop, provider-to-worker wiring, sandbox execution integration, real verification evidence, and final patch delivery remain unfinished. Do not treat passing fixture tests as evidence that agents executed or tested project code.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
