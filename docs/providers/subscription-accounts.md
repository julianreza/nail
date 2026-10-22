# Subscription account connectors

## Current support status

Nail exposes owner-only provider setup, connection checks, disconnect, and safe status display. A successful binding is not currently available for model use: local CLI adapters return `not_installed` when the configured binary is absent, `unsupported` when its subscription-auth status cannot be verified, and a fail-closed isolation error for inference. Claude is disabled until its subscription policy and official CLI auth flow are verified. No live account or model request was tested in this workspace.

The panel does not accept API keys or login tokens. The owner must install and authenticate an official CLI locally on the connector host; Nail does not read token files or copy credentials between applications.

## Connector configuration

Set these server-only variables for the connector process:

- `NAIL_CONNECTOR_SOCKET`: absolute path to the private Unix socket.
- `NAIL_CONNECTOR_BINDINGS_FILE`: absolute path to the owner-only JSON config named `bindings.json`.

Next.js needs only `NAIL_CONNECTOR_SOCKET`. It discovers safe binding metadata through that socket; do not mount the bindings file or account homes into the web container.

The config parent is the connector data root. It must be a real directory owned by the service account with mode `0700`; `bindings.json` must be owned by the service account with mode `0600`. The socket basename must be `provider.sock`; its parent must also be a real, service-owned `0700` directory. It may be the connector root or a separate non-overlapping directory for sharing only the socket with the web container. The socket is created with mode `0600`. The connector rejects a pre-existing socket path rather than deleting it. See `../docker-runtime.md` for the container layout.

Create `<connector-root>/accounts/<bindingId>` with mode `0700` for each dedicated vendor home. Never use a personal interactive home or the Nail repo. The file format is versioned and has exact fields:

```json
{
  "version": 1,
  "bindings": [
    {
      "bindingId": "codex-owner",
      "kind": "codex",
      "executable": "/opt/vendor-bin/codex",
      "home": "/var/lib/nail-subscriptions/accounts/codex-owner",
      "model": "<model-slug-reported-by-the-installed-cli>",
      "enabled": true
    }
  ]
}
```

Use `kind` exactly `codex`, `antigravity`, or `claude`; use the CLI executable basename exactly `codex`, `agy`, or `claude`. Binding IDs use lowercase letters, digits, `_` or `-`, 1–64 characters. The model must be accepted by the installed provider client. Do not put credentials in this file. Do not select `claude` for a working subscription until policy verification has passed.

Keep the account homes outside the application, sandbox and personal home. An absent CLI executable is retained as a safe `not_installed` binding so the dashboard can report the blocker. A recognized Codex ChatGPT auth status can report `connected`, but an unverified auth schema remains `unsupported`; a successful filesystem check never proves authentication. No subscription account is inference-ready until the separate compatibility/isolation gates pass.

## Run the connector

The connector is a separate local process and listens only on the configured Unix socket:

```sh
bun run providers:connector
```

Run it as the same dedicated service account that owns the connector root and vendor account homes. Configure only `PATH`, `HOME`, temp/locale/TLS variables and the two `NAIL_CONNECTOR_*` paths in its service environment. The daemon removes other variables, including Nail database/session/secret-store settings, API keys, proxy configuration and Node options, before starting. The CLI child receives a smaller allowlist. Do not run the connector in the untrusted repository-command sandbox and never mount account homes into that sandbox.

Stop with `Ctrl+C` during local development or send `SIGTERM` to the service process. It aborts active calls, closes the socket and removes only the socket inode it created. No systemd unit or production deployment automation is included yet.

## Official CLI notes

- **Codex:** official docs support ChatGPT sign-in (`codex login`) and distinguish it from API-key billing. Nail parses only recognized cached auth-status messages from stderr in a dedicated HOME/CODEX_HOME with explicit file storage; API-key mode never counts as connected. See [Codex OAuth setup](codex-cli-oauth.md) for private-terminal login and headless alternatives. Parsing is source-verified with synthetic tests; live login compatibility is unverified until owner acceptance. A connected account remains unavailable for inference.
- **Antigravity:** official docs call the CLI `agy` and document `agy models` plus headless JSONL. Nail has not verified personal OAuth status or tool-denial behavior for an installed version; no `agy login` command is assumed.
- **Claude Code:** official authentication/policy docs were blocked during the compatibility review. The UI intentionally blocks it; do not configure a different billing/auth mode to bypass that gate.

The compatibility record is `docs/providers/subscription-compatibility.md`. A binding becomes inference-ready only after the exact CLI version/auth mode, tool/MCP/plugin denial, OS file isolation, and finite token-budget behavior pass their provider-specific review. At present the reviewed isolation-profile list is empty, so every subscription inference request fails closed. The generic `bwrap` canary proves only filesystem masking; it does not prove network egress filtering or vendor-tool isolation.

## Opt-in smoke test

The smoke script never logs in, installs a CLI or prints raw provider output. Without `--allow-live`, it does not open the connector socket. A live text call may consume subscription quota and is unavailable until a binding reports `ready`:

```sh
node scripts/subscription-provider-smoke.mjs --binding codex-owner --allow-live
```

Expected exit code is `0` only for a ready binding returning exactly `NAIL_OK`; missing, unsupported or blocked bindings return exit code `2` and a safe JSON status. Current host CLI discovery found no `agy`, `codex` or `claude` executable; no live probe has been run.
