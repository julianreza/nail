# Codex ChatGPT OAuth in a dedicated connector home

Nail checks the official Codex CLI's **cached authentication method**. OAuth login, token storage, refresh and logout remain owned by that CLI. A recognized ChatGPT login produces connection state `connected`, **not** inference `ready`: provider status remains `unavailable`, with no inference capabilities. Status does not verify token freshness, subscription entitlement, model availability or a successful live model request.

Auth-status parsing is verified against pinned official source and synthetic local tests. No live Codex account or deployed binary has been validated in this workspace. Unknown output fails closed. No custom OAuth client, callback, direct ChatGPT API call or API-key fallback is implemented.

## Prerequisites

Follow [subscription account connector configuration](subscription-accounts.md) first. An administrator must provision:

- The official CLI at the binding's absolute executable path; this runbook uses `/opt/vendor-bin/codex` as an example, not an installation command.
- A dedicated account home at `<connector-root>/accounts/<bindingId>`, owned by the connector service account with mode `0700`. The example uses `/var/lib/nail-subscriptions/accounts/codex-owner`.
- Owner-only `bindings.json` with mode `0600`, the exact matching `home`, executable, `kind: "codex"`, `bindingId: "codex-owner"`, an administrator-selected model and `enabled: true`. A status check does not discover or validate models.
- A private writable scratch directory selected by the connector service's `TMPDIR`. Nail creates an empty per-check directory there and removes it on completion, failure or cancellation.
- A private service-account terminal in the **same runtime and filesystem** as the connector. A login on a personal workstation or in a different container is not the connector account.

Replace example paths/IDs with the actual administrator configuration. Never use a personal home, personal `~/.codex`, Nail checkout or sandbox home. Do not mount account homes into the web or sandbox container. Restrict backups and all files/logs under CODEX_HOME as credential-sensitive; file-based credentials are bearer secrets, not encrypted by Nail.

## Sign in privately

Use the dedicated service account, not root or a different interactive user. Do not paste credentials, OAuth URLs, one-time codes, account identity, masked API keys, `auth.json` or raw CLI diagnostics into Nail, Discord or shared logs.

```sh
# Precondition: administrator provisioned this existing private directory and binary.
export HOME=/var/lib/nail-subscriptions/accounts/codex-owner
export CODEX_HOME="$HOME"
unset OPENAI_API_KEY CODEX_API_KEY CODEX_ACCESS_TOKEN NODE_OPTIONS
/opt/vendor-bin/codex --version
/opt/vendor-bin/codex -c 'cli_auth_credentials_store="file"' login
/opt/vendor-bin/codex -c 'cli_auth_credentials_store="file"' login status
```

Select **Sign in with ChatGPT**, not API-key billing. The unset list is an operator precaution, not the subprocess security boundary: Nail supplies its own explicit child environment and does not inherit keys, tokens, proxies, database/session configuration or Node options.

The successful source-verified result is exactly `Logged in using ChatGPT` on **stderr**, exit `0`. Logged out is `Not logged in` on stderr, exit `1`. Do not stream raw output into application or centralized logs: API-key status may include a masked key. Record only the installed CLI version and sanitized auth-mode outcome in private compatibility records.

The file-storage override must be identical for login, status and logout. It keeps authentication within the dedicated CODEX_HOME rather than reusing an OS keyring. If managed policy prohibits this storage mode, do not bypass policy; this binding is unsupported/unavailable. Nail never writes auth configuration or reads `auth.json` itself. Do not force `forced_login_method` merely to diagnose authentication: a mismatched configured restriction can log out credentials.

## SSH / headless sign-in

Device-code authentication is documented as beta and must first be enabled in the personal account security settings or workspace permissions. In the same private service-account terminal with the dedicated HOME/CODEX_HOME:

```sh
/opt/vendor-bin/codex -c 'cli_auth_credentials_store="file"' login --device-auth
```

Enter the one-time code only in the official browser sign-in page. Never submit it to Nail or chat.

If device authentication is unavailable, forward the official localhost callback from the owner's workstation:

```sh
ssh -L 1455:localhost:1455 SERVICE_USER@CONNECTOR_HOST
```

Inside that SSH session, set the dedicated HOME/CODEX_HOME as above, then run the ordinary file-storage `login` command and follow the CLI browser flow locally. Replace the SSH target with the actual service account and connector host. This runbook deliberately excludes copying personal auth caches.

## Connect in Nail

1. Run the connector normally with its private socket and binding config: `bun run providers:connector`. Next.js needs only `NAIL_CONNECTOR_SOCKET`, not account homes or the bindings file.
2. In Providers → Codex Subscription, enter the exact configured binding ID and model, then save and check.
3. Click **Periksa koneksi** to recheck after manual login/logout. Nail runs only `codex -c 'cli_auth_credentials_store="file"' login status`, with empty stdin, a five-second timeout, an 8 KiB combined-output cap, empty scratch cwd and `HOME === CODEX_HOME === binding.home`. PATH is fixed to trusted `/usr/bin:/bin`; this check uses no inherited certificate/proxy settings and does not verify remote entitlement. It never invokes `exec`, sends a prompt or starts login.
4. Read back the same provider ID in the authenticated `/api/providers` list. Expected: connection `connected`, provider `unavailable`. A saved binding, source review or synthetic fixture is not a successful live login.

Safe outcomes:

- `connected`, reason null: exact cached ChatGPT status recognized, not inference-ready.
- `needs_login`, reason `needs_login`: explicit logged-out result.
- `unsupported`, reason `wrong_auth_mode`: recognized API-key status; no billing fallback.
- `unsupported`, reason `auth_status_unverified`: empty, mixed-channel, new or unknown output/auth mode.
- `not_installed`, reason `cli_not_installed`: configured executable is missing.
- `unavailable`: safe process failure such as `timeout`, `output_limit`, invalid configuration or inaccessible storage. Raw exception text is not exposed.

Unknown/new CLI formatting stays unsupported until a sanitized structural fixture is reviewed for the exact deployed version. Do not accept arbitrary substrings or open auth files as a workaround. Nail checks only on an owner-triggered setup/check request, not through automatic OAuth polling.

## Disconnect versus logout

**Lepas binding** disables Nail's binding and cancels active connector work; it does not clear or revoke vendor credentials. To log out explicitly, use the same private service account and dedicated HOME/CODEX_HOME:

```sh
/opt/vendor-bin/codex -c 'cli_auth_credentials_store="file"' logout
```

Only do this with owner approval. A subsequent owner-triggered check should return `needs_login`. Nail never runs vendor logout during a connection check.

## Verification and remaining gates

Automated parser/adapter tests use synthetic status fixtures, not a real account. Local process-runner tests exercise cancellation, timeout and child-process controls. PostgreSQL regressions prove that `connected` remains persisted but not inference-ready. To validate a real deployment, the owner must provide/install the official binary, record its exact version, complete sign-in privately and read back the same provider row in Nail. No model probe or subscription quota consumption is part of this acceptance.

Inference remains blocked until an independently reviewed CLI-specific isolation profile and finite-output-budget mechanism are proven. Do not add a profile, capabilities, `ready` status or loosen provider-selection/approval gates merely because login succeeds.

## Official references

- [Codex authentication](https://developers.openai.com/codex/auth.md): ChatGPT versus API billing, status/logout, CODEX_HOME and file storage, headless login.
- [Pinned CLI status implementation](https://github.com/openai/codex/blob/430a16799d90e296fb27b1e94f206023902b7e56/codex-rs/cli/src/login.rs#L448-L514): stderr messages and exit codes; source evidence, not a deployed-version guarantee.
- [Compatibility record](subscription-compatibility.md) and [connector setup](subscription-accounts.md).
