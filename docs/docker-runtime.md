# Docker runtime

## Scope

The Dockerfile has two explicit targets: `app` (Next.js standalone on Node 24) and `connector` (a Bun 1.4.3 compiled Linux x64 daemon). Always specify `--target`; the final/default target is the connector. The application build uses the declared frozen Bun lockfile and the default Turbopack build, not a Webpack fallback.

This packages the control plane and private subscription connector only. It does not integrate the worker, authorize execution, install vendor CLIs, authenticate accounts, enable subscription inference, configure TLS, or deploy to a VPS. No Docker socket should be mounted into either service.

## Build and exercise locally

From this worktree/repository root, with Docker running:

```sh
docker build --target app -t nail-docker-runtime:local .
docker build --target connector -t nail-connector-runtime:local .
node scripts/docker-runtime-smoke.mjs
```

The smoke test uses uniquely named disposable containers/volumes and local PostgreSQL 17, generates temporary owner/database credentials locally, and publishes an ephemeral loopback-only application port. It removes its own containers and volumes in `finally`; it does not touch existing app data, Supabase projects, or real accounts. The app shares only the disposable PostgreSQL container's network namespace for local loopback database transport; the database port is not published. It checks:

- Missing required secrets cause exit 1.
- Both images start with read-only root filesystems.
- Owner login, unauthorized access and exact-origin rejection work.
- App PID 1 runs as UID/GID 10001 with zero effective capabilities after bootstrap.
- Only the socket volume, not the private account volume, is shared with the app.
- A configured but absent official CLI is reported as `not_installed`, never ready.
- Provider metadata persists through an application restart and remains usable for a connector check.
- The connector has neither `DATABASE_URL` nor the database secret mount.

`NAIL_SMOKE_APP_IMAGE`, `NAIL_SMOKE_CONNECTOR_IMAGE`, and `NAIL_SMOKE_POSTGRES_IMAGE` can override image tags. The test sends an HTTPS Origin header to the loopback HTTP backend and handles its Secure cookie explicitly; it does **not** exercise a real TLS proxy or browser cookie transport, nor does it certify Supabase TLS connectivity. Production requires HTTPS at the reverse proxy and verified database TLS for remote endpoints.

## Application container contract

Mount four required, nonempty, read-only secret files under `/run/secrets`:

- `owner_password_hash`: only the value from `scripts/hash-owner-password.mjs`, not the `OWNER_PASSWORD_HASH=` prefix.
- `session_secret`: only the value from `scripts/generate-session-secret.mjs`.
- `nail_secret_encryption_key`: only the value from `scripts/generate-encryption-key.mjs`.
- `database_url`: your Supabase direct or session-pooler PostgreSQL connection URL. The entrypoint exports it as server-only `DATABASE_URL`. Never mount this secret directory into the connector or sandbox.

Do not pass secrets as Docker build arguments, put them in the build context, or bake them into an image. Keep source secret files outside the repository and build context. `.dockerignore` excludes `.env*`, private PEM files, old local database files, local dependencies and worktrees; it is not a substitute for keeping arbitrary secret directories outside the build context. Building needs no database credentials or connectivity.

Set runtime environment explicitly:

```text
APP_ORIGIN=https://your-exact-hostname
NAIL_SECRET_DIR=/var/lib/nail/secrets
NAIL_CONNECTOR_SOCKET=/socket/provider.sock
```

`APP_ORIGIN` must be an exact HTTPS origin in production; HTTP is deliberately rejected by authentication. Publish the backend on loopback behind a separately managed HTTPS proxy.

Mount persistent application file storage at `/var/lib/nail`; back up the encrypted secret directory, encryption key and workspace/artifact files separately from PostgreSQL. Use Supabase backup/PITR or consistent PostgreSQL backups for database state. There is no old-data import or local-file database fallback. Remote connections verify certificates; if required, mount a trusted CA read-only and set `DATABASE_CA_CERT_PATH` to its path. See [PostgreSQL operations](postgresql.md).

The entrypoint loads secrets, initializes private directory permissions and ownership, then drops all capability sets and starts Node as UID/GID 10001. The app therefore starts briefly as container root; do not override `--user` for this target.

For a hardened read-only container, the smoke test demonstrates these flags:

```text
--read-only
--cap-drop=ALL
--cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=FOWNER
--cap-add=SETUID --cap-add=SETGID --cap-add=SETPCAP
--security-opt=no-new-privileges:true
--tmpfs /tmp:rw,nosuid,nodev,size=32m
--tmpfs /app/.next/cache:rw,uid=10001,gid=10001,size=32m
```

Those capabilities are for secret/directory bootstrap and UID transition only; the smoke test reads `/proc/1/status` to verify that Node retains none. The entrypoint intentionally refuses startup when filesystem permissions cannot be secured. Rootless Docker named volumes were exercised; arbitrary host bind-mount ownership mappings were not.

## Connector container contract

The connector image runs as UID/GID 10001 from the outset, has no published port, and needs no capabilities. Use `--read-only --cap-drop=ALL --security-opt=no-new-privileges:true` and a writable `/tmp` tmpfs.

Set `HOME=/tmp`, `NAIL_CONNECTOR_BINDINGS_FILE=/accounts/bindings.json`, and `NAIL_CONNECTOR_SOCKET=/socket/provider.sock`. Initialize the following with owner UID/GID 10001 before starting:

- Private `/accounts`, `/accounts/accounts`, and dedicated `/accounts/accounts/<bindingId>` directories, all mode `0700`.
- `/accounts/bindings.json`, mode `0600`, in the exact schema documented in `providers/subscription-accounts.md`.
- Separate `/socket` directory, mode `0700`; the connector creates `provider.sock` with mode `0600`.

The `/accounts` and `/socket` volume roots must not overlap. Mount only `/socket` into the app (read-only is sufficient for connecting to the existing Unix socket). Never mount `/accounts`, vendor account homes, the binding config or vendor binaries into the application or untrusted command sandbox. The app discovers only safe binding descriptors through the private socket protocol; it no longer needs the binding config environment variable or file.

The image contains an empty `/opt/vendor-bin` directory, not vendor clients. Configure an absent executable there to get a truthful `not_installed` diagnostic. Installing/pinning official clients, initializing dedicated homes, authenticating and proving policy/isolation/budget controls is separate owner-authorized work. A container boundary alone does not satisfy those inference gates.

The connector refuses to overwrite a pre-existing socket. Clean SIGTERM shutdown removes its own socket; after an unclean crash, the operator must first confirm no live connector owns it before removing a stale socket. Do not blindly delete a socket during startup.

## Verification recorded for this work

`docker-runtime-validation.md` records historical pre-PostgreSQL evidence. Current PostgreSQL validation is recorded in `postgresql-validation.md`. Local runtime evidence is not target-VPS, real-browser/TLS, resource-limit or live-provider certification.
