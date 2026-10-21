# PostgreSQL operations

## Fresh Supabase setup

Nail connects to PostgreSQL using `pg`, not the Supabase browser SDK or PostgREST. No Supabase credentials are shipped with this repository. Nothing automatically discovers or connects to an external project.

1. Choose your own fresh Supabase project/database and copy its direct connection or **session pooler** connection string from Connect. The session pooler is useful on IPv4-only hosts. Do not use the transaction pooler for the migration/connection lifecycle.
2. Supply the database-owning login in server-only `DATABASE_URL`. Percent-encode special characters in username/password. The migrations require table/index creation, alteration, RLS and permission management. A Supabase API key is not a database password. Do not reuse a populated unrelated schema: Nail owns the named tables it creates.
3. Configure trusted TLS. `sslmode=verify-full` is recommended; `require` and `verify-ca` still enforce certificate and hostname verification in this application. A private issuer requires a trusted CA file via `DATABASE_CA_CERT_PATH`. URL-provided TLS weakening options cannot override the explicit driver TLS configuration. No `rejectUnauthorized: false` or unverified remote fallback is used. Only loopback PostgreSQL can use plaintext.
4. Set owner authentication and encrypted-secret storage independently, as described in README. Start the app, authenticate, and load a data-backed page. The first authorized database access applies schema migrations. Unconfigured requests return a configuration error instead of inventing data.

Docker loads `DATABASE_URL` from the `/run/secrets/database_url` file at runtime. A separate read-only CA mount can be referenced with `DATABASE_CA_CERT_PATH`. Build arguments must never contain these values. The app image includes the `pg` runtime dependency through Next's standalone tracing; Next 16.4.2 automatically externalizes `pg`.

## Cutover and backups

This is a fresh database cutover, not an old-data migration. There is no embedded/file database driver, file-path configuration or import of previous data. Existing historical validation/design documents describe older implementations and are not current configuration guidance.

Use Supabase's database backup/PITR facilities or a consistent PostgreSQL backup. Back up the encrypted provider-secret directory and its encryption key separately. Workspace/checkpoint/artifact files remain filesystem-backed; PostgreSQL stores their metadata, not their file contents. Removing the local database file does not remove the need to retain those files. Authentication remains owner-only and uses the existing process-local session mechanism; this change does not add Supabase Auth.

## Schema and transaction contract

- Migrations in `lib/server/db/migrations.ts` are versioned and applied atomically under a transaction-scoped advisory lock, acquired before reading/creating the migration table. Migration errors roll back. Reopening is idempotent.
- All repositories, SQL execution, approval, queue, budget and workspace operations are asynchronous. The small `prepare` wrapper parameterizes SQL; it does not create named server prepared statements or emulate another database engine.
- `withTransaction` reserves one `PoolClient` from BEGIN through COMMIT/ROLLBACK. Async-local context binds every participating repository operation, including awaited callbacks, to that connection. Overlapping transactions on the same `Database` do not share a connection. Concurrent queries within one transaction are queued. Nested calls join the parent; even a caught nested failure aborts the parent rather than committing partial work. Detached work after the transaction closes is rejected.
- Nail intentionally serializes orchestration mutations globally using `pg_advisory_xact_lock`. This covers absent lease rows, duplicate approval submission, decision/queue transitions, task scheduling, usage reservation/settlement and expired-lease recovery across processes. Heartbeats participate in the same lock and are drained before worker finalization. Do not run model/network requests inside a transaction.
- Pools allow at most five connections per opened handle. Request handlers close handles in `finally`; a worker retains its own handle until shutdown. Account for concurrent web requests and workers when sizing Supabase connection limits; this is not a distributed high-throughput scheduler.
- Foreign keys, enum-like CHECK constraints, singleton/unique indexes, one-running-task-per-run, nonnegative budgets/counters, JSON shape checks, secret-free subscription records and native `TIMESTAMPTZ` protect persisted state. Timestamp values are returned as ISO strings. BIGINT values are accepted only within JavaScript's safe integer range. SQL camelCase aliases are quoted explicitly.
- RLS is enabled without public policies on Nail tables. PUBLIC and the Supabase `anon`, `authenticated`, and `service_role` roles (when present) receive no table access. The trusted database-owning server login performs mutations. Never give the browser or private provider connector this login, the app secret mount, or the CA configuration. Later migrations that add tables must preserve these restrictions.

## Local verification

With Bun 1.4.3 and Docker available:

```sh
bun install --frozen-lockfile
bun run test:postgres
bun run lint
env -u DATABASE_URL -u DATABASE_CA_CERT_PATH bun run build
```

`test:postgres` starts PostgreSQL 17 in a uniquely named container with temporary data and a loopback-only ephemeral port. It overrides inherited `NAIL_TEST_DATABASE_URL` and removes its own container in `finally`. Override the official image with `NAIL_TEST_POSTGRES_IMAGE` if necessary. It never uses an application/Supabase URL.

For an explicitly selected disposable PostgreSQL instance, set `NAIL_TEST_DATABASE_URL` yourself, then run `bun run test`. The Vitest-only setup creates and later drops isolated fixture schemas and aliases only the Next `server-only` guard; database queries use the real `pg` driver and PostgreSQL. A few explicit transport regression tests exercise the supplied database's default schema too. Therefore this URL must NEVER identify production or an unknown remote project. Missing test configuration fails database tests clearly. No database responses or live-provider results are fabricated.

The separate sandbox Docker test remains opt-in (`NAIL_LIVE_SANDBOX=1`). The runtime smoke in `scripts/docker-runtime-smoke.mjs` starts its own local PostgreSQL and verifies provider metadata after an app restart. See `docs/docker-runtime.md`.
