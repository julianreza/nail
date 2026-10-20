# Subscription provider compatibility (checked 2026-10-20)

This file records observed vendor documentation and this connector host's state. It does not claim any user account is logged in. Credentials, auth caches, and live completions were not inspected or used.

## Host discovery

Commands run in `/home/ubuntu/Project/nail/.worktrees/provider-setup`:

```text
command -v agy   -> not installed on PATH
command -v codex -> not installed on PATH
command -v claude -> not installed on PATH
```

No CLI version, login status, headless invocation, account home, or model inventory can be verified on this host. No automatic installation was attempted.

## Antigravity (`agy`)

**Sources inspected**
- https://antigravity.google/docs/getting-started
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/permissions/

**Documented facts**
- The vendor documents the CLI executable as `agy` (not `antigravity`), and documents personal account auth as `oauth-personal` in its authentication configuration section.
- `agy models` lists supported model slugs. Headless mode supports JSON and stream-JSON input/output. A single prompt can be sent on stdin as `{"event":"user","message":{"content":"..."}}`; the process emits a terminal `result` event whose result has a status such as `SUCCESS`, `ERROR`, `WAITING`, or `INTERRUPTED`.
- `~/.gemini/antigravity-cli/settings.json` is the CLI settings path. Permissions use allow/deny/ask rules; deny takes precedence. Workspace reads/writes are allowed by defaults, and commands may be soft-denied in headless mode.
- Docs separately describe API-key / Vertex / enterprise auth. Those modes are not evidence that a personal subscription binding is active.

**Exact auth-status schema, supported login command, dedicated-home override, hard output-token cap, and a way to disable all agent tools while retaining model-only output:** not verified. CLI is absent and no authenticated account is configured here.

**Plan gate:** `connectionSupported=false` on this host (client absent). Personal-account connection may be prototyped only behind an explicitly unavailable diagnostic until the pinned official auth flow and credential-home isolation are validated. `completionSupported=false`; do not invoke `agy` to generate plans until tool isolation and the finite output-budget gate are proven. Never use `--dangerously-skip-permissions`.

## ChatGPT / Codex (`codex`)

**Sources inspected**
- https://developers.openai.com/codex/auth.md
- https://developers.openai.com/codex/noninteractive.md

**Documented facts**
- Codex CLI supports sign-in with ChatGPT for subscription access and API-key access billed through the OpenAI API. These modes have different billing and workspace controls.
- CLI documents `codex login` for browser sign-in and `codex login status` for inspecting the active login method. Codex credentials are kept in the CLI credential store / `CODEX_HOME`; they are bearer credentials and must be protected like a password.
- `codex exec --json` emits JSONL events; `--ephemeral` avoids saving rollout files. Codex CLI is an agent CLI, not documented as a raw token-capped completion API. API-key usage is billed separately. Its default automation sandbox is read-only, but that alone does not prove project instructions/tools/MCP are disabled.

**Not verified on this host:** installed version, exact CLI output for `codex login status`, dedicated `CODEX_HOME` login flow, whether this execution profile enforces ChatGPT-only auth, exact model selection behavior, and a hard output-token cap. No login state or auth file was read.

**Plan gate:** `connectionSupported=false` on this host (client absent). Documented ChatGPT login is a potential supported route, but status must remain not-installed until verified with an installed official CLI. `completionSupported=false` until tool isolation is established and a hard finite output budget can be enforced; API-key fallback is prohibited.

## Claude Code (`claude`)

**Sources attempted**
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/authentication.md
- https://code.claude.com/docs/en/cli-reference.md
- https://platform.claude.com/docs/en/agent-sdk/overview

The official Code and Platform documentation requests returned HTTP 403 during this check. An Internet Archive availability record existed, but fetching the archived page returned HTTP 429. A locally installed Hermes `claude-code` skill describes OAuth/CLI commands, but it is secondary guidance, not authoritative evidence for vendor terms or an approved subscription automation interface. No CLI is installed here.

**Exact official subscription login/status commands, subscription automation permissions, dedicated-home behavior, completion envelope, model selection, tools/MCP disabling, and output-token cap:** not verified.

**Plan gate:** `connectionSupported=false` and `completionSupported=false` until official docs and terms for the specific Claude subscription use case are confirmed and tested. The connector must not infer support from an Anthropic API key, Console/Bedrock/Vertex mode, `setup-token`, or an OAuth token reused against an API endpoint. If the gate remains unresolved, show Claude as unavailable with `policy_unverified`; do not implement a functional subscription adapter.

## Host isolation probe

- `bwrap`, rootless Docker, `unshare`, and `nft` are present on this host; Docker reports rootless mode and cgroup v2.
- A synthetic `bwrap --unshare-user --unshare-pid --ro-bind / / --tmpfs /home --tmpfs /root --tmpfs /run --proc /proc --dev /dev --tmpfs /tmp ...` canary passed: the synthetic dedicated account marker was readable, the project under `/home/ubuntu/Project/nail` was not visible, and `/etc` was not writable. No real account home or credential was mounted.
- This proves only a generic read-only filesystem boundary. The canary did **not** validate any vendor CLI, disable its tools/MCP/plugins/hooks, constrain outbound network, or enforce a model token budget. No verified isolation profile is enabled.

## Binding readiness criteria

A binding can be `connected` only after official CLI auth status confirms the required subscription mode under its dedicated administrator-controlled home. It can be `ready` only after all of the following are proven on the target host:

1. The exact supported client version and output/auth schema are pinned and tested.
2. No API-key, custom API-base, cloud-provider, proxy, or other billing credentials are present in the child environment or credential home.
3. Vendor agent tools, project hooks/plugins/MCP, shell execution, filesystem access, and repo instructions cannot be used by the text-only completion invocation; an OS boundary independently limits file access.
4. The selected model is reported by the installed official CLI and a live, owner-approved harmless probe returns a valid completion.
5. The requested finite generation limit is enforceable. A wall-clock/output-byte cap is not a substitute for an output-token cap.

Until those gates pass, adapters may report installation/auth diagnostics only; they must return `tool_isolation_unverified`, `budget_unenforceable`, or `policy_unverified` before starting an inference process. No plan-generation route may claim success or fall back to another provider.
