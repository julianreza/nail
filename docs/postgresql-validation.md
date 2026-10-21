# PostgreSQL cutover validation

## Implemented

- Replaced runtime embedded/file database access with async `pg` and server-only `DATABASE_URL`.
- Converted repositories, HTTP handlers, dashboard reads, orchestration, workspace/provider services, worker calls, stream finalization and related tests to async.
- Reserved-connection transactions use async-local context, queued connection queries, real rollback and a transaction-scoped advisory lock. Queue/approval/task/usage mutations and heartbeats retain serial invariants across pools/processes.
- PostgreSQL migrations are versioned and advisory-locked before schema inspection. Native timestamps, CHECK/FK/unique constraints, quoted aliases, JSON validation, RLS and revoked Supabase API-role grants are covered by regression tests.
- Added `.env.example`, PostgreSQL operations documentation, a disposable test runner, Docker secret loading and PostgreSQL-backed runtime smoke.
- No old data was imported. No external database or live provider account was used. No commit or deployment was made.

## Executed evidence

1. Before implementation, `tests/server/db/postgres.test.ts` failed against the old implementation: `no such function: version` and `column index out of range`. After replacement it passed against actual local PostgreSQL.
2. The additional native schema constraint test initially failed because an invalid task state was accepted; it passed after the PostgreSQL constraints were implemented.
3. `bun install --frozen-lockfile`: passed; no package-lock was created.
4. `bun run test:postgres`: passed against a new disposable local PostgreSQL 17 container. Final result: **52 test files passed, 1 skipped; 206 tests passed, 1 skipped**. The runner also creates Supabase-style API roles/default table grants, and tests verify migrations revoke access. The skipped test is the separately opted-in live sandbox test.
5. Concurrency coverage includes simultaneous migrations, backend identity across async transaction operations, overlapping commit/rollback, caught nested failure rollback, one approval-submission identity, one decision winner, one global queue claim, serial task starts and no overspending under simultaneous budget reservations.
6. `bun run lint`: passed. `git diff --check`: passed. ESLint/Vitest now exclude sibling worktrees so stale copies and generated files are not misreported as this checkout's source.
7. `env -u DATABASE_URL -u DATABASE_CA_CERT_PATH bun run build`: passed, including TypeScript and 22 generated static routes/pages. No database credentials/connectivity were needed.
8. Both Docker targets built successfully as `nail-postgres-app:local` and `nail-postgres-connector:local`. The first app build command exceeded its foreground time limit after dependency installation/build; a subsequent complete build succeeded.
9. The updated runtime smoke passed using those images and its own disposable PostgreSQL: required-secret failure, owner login/origin protection, private socket provider discovery, UID 10001/no effective capabilities, no private account/Docker socket mounts in the app, provider state surviving app restart, and no database credential/secret mount in the connector. Subscription inference remained truthfully unavailable.
10. Source search found no runtime/test `node:sqlite`, old database-path variable, `DatabaseSync`, PRAGMA or BEGIN IMMEDIATE usage. Historical design/validation records and ignored sibling worktrees still describe prior implementations.

A pre-existing mascot interaction assertion expected antenna rotation 5 while the implementation and companion pose tests specify 8. Only that stale assertion was aligned; mascot behavior was not changed.

## Limits and blocked maintenance

- No Supabase credentials were available, so Supabase DNS/network connectivity, project permissions, and a live Supabase TLS handshake were not exercised. Certificate verification and resistance to URL-based TLS weakening are tested at driver configuration level. Local database tests and Docker smoke use loopback PostgreSQL.
- The execution environment denied the requested protected `AGENTS.md` write. It remains unchanged and its database guidance is stale; README and `docs/postgresql.md` contain current operating instructions.
- The initial manually launched local test container, `nail-pg-migration-test`, remains running because the environment denied its cleanup command. Containers launched by `test:postgres` and runtime smoke were removed by their own cleanup paths. Existing production containers were not changed.
- The original unrelated untracked `.hermes/plans` files were preserved. A separate concurrent edit to `tests/ui/reference-theme.test.tsx` was observed and left untouched.
