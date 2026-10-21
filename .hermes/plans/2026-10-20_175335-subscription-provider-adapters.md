# Subscription account adapters: Antigravity, Codex, Claude

> **Execution:** Use `superpowers:executing-plans` or `superpowers:subagent-driven-development`. This file is the design and implementation brief. Planning only was requested; none of its implementation commands have been executed.

## Goal
Connect Nail to owner-managed Antigravity, ChatGPT/Codex, and Claude subscription accounts through supported vendor clients, with safe connection diagnostics and provider-routed plan generation where policy and execution controls have been verified.

## Current context and assumptions

- Repository: `/home/ubuntu/Project/nail`; Next.js 16.4.2, React 19.3.0, strict TypeScript, SQLite (`node:sqlite`), Vitest, Bun declared in `package.json`.
- This plan is saved in the active workspace, not in the feature worktree. Implementation should continue in `/home/ubuntu/Project/nail/.worktrees/provider-setup` on `feature/provider-setup` or a successor worktree containing those changes.
- `main` is at `aec9326`. Its uncommitted `AGENTS.md`, `.hermes/`, and image belong to existing work: do not stage, discard, or overwrite them.
- `feature/provider-setup` has **uncommitted** DeepSeek setup service, handler, UI, tests, and design docs. They are a dependency, not committed history. Preserve and checkpoint them before starting this plan. Do not merge to main or push without permission.
- Existing `lib/server/db/repositories.ts` supports `authMode: "api_key" | "subscription_cli" | "none"`, but has no stable provider-kind or account-binding field. Names are display strings, not adapter identifiers.
- `lib/server/providers/deepseek-adapter.ts` is an HTTP adapter specific to DeepSeek. `lib/server/orchestration/run-request.ts` currently rejects any provider that is not ready DeepSeek/API-key.
- `createRunPlanFromGoal(database, input, policy, generate)` accepts a `PlanGenerator`; `PlanGeneratorInput` contains run/provider IDs, goal, baseline, agents, allowed tools, and max output tokens. The project's run-list API currently only exports GET. No PM/engineer/QA production loop exists.
- `worker/runner.ts` leases jobs and invokes an injected `JobExecutor`. `worker/sandbox/` is intended for **untrusted repository commands**, has network disabled, and deliberately has no account secrets. Never mount subscription credentials into that sandbox.
- None of `codex`, `claude`, or `antigravity` was found on the inspected PATH. The documented Antigravity executable is **`agy`**; its installation was not checked during the initial executable probe. Task 1 checks all three correct names. No login, live inference, or credential reads were performed.
- Prior feature verification: 79 tests and ESLint passed; Webpack production build passed. Turbopack failed resolving dependencies outside its worktree root. Re-run the baseline: these are historical results, not a guarantee about a future tree.
- Owner-only, one account binding per provider kind initially. No multi-tenant credential sharing, automated account pools, quota circumvention, or automatic provider/account switching.

### Sources actually inspected on 2026-10-20

1. `https://developers.openai.com/codex/auth.md`: ChatGPT sign-in, `codex login`, `codex login status`, `CODEX_HOME`, `forced_login_method = "chatgpt"`, and optional device authentication.
2. `https://developers.openai.com/codex/noninteractive.md`: `codex exec`, stdin prompts, `--json` events, `--ephemeral`, default read-only sandbox, final usage events, and explicit warnings concerning account automation on untrusted/public repositories.
3. `https://antigravity.google/docs/getting-started`: official CLI is `agy`; personal OAuth auth type is `oauth-personal`; model availability is plan-dependent. The SDK API-key quickstart is **not** evidence that subscription accounts can be used through the SDK.
4. `https://antigravity.google/docs/cli/headless/`: headless JSON/stream JSON, stream-input protocol, terminal status envelope, `agy models`, and timeout/permissions behavior.
5. `https://antigravity.google/docs/permissions/`: deny/ask/allow precedence; file operations inside workspace are automatically allowed unless explicitly denied; global CLI settings location is `~/.gemini/antigravity-cli/settings.json`.
6. Claude official `https://code.claude.com/docs/en/authentication`, its `.md` variant, CLI reference, and the platform SDK overview returned HTTP 403. An archive was discovered but its body returned 429. Local `claude-code` skill describes CLI OAuth and `-p --output-format json`; it is helpful context, **not proof of current vendor policy**.

**Important:** Earlier conversation said Antigravity was not yet integrated; it did not establish that no supported integration exists. Current retrieved docs show a CLI route. Conversely, do not claim Claude subscription integration is officially authorized until Task 1 verifies the current terms and permitted CLI automation route.

## Architecture / proposed approach

Use vendor-owned CLI authentication and refresh behavior behind a local, trusted subscription connector; Nail stores only an opaque binding ID, provider kind, selected model, and safe connection status. The Next.js process talks to this connector over an owner-only Unix socket; vendor processes use dedicated credential homes and do not receive Nail secrets, database paths, repository mounts, or browser-supplied executable paths. Start with account connection and text-only PM planning; enable generation only after verifying tool denial and subscription-only billing, keeping all real repository execution behind Nail's existing approval/sandbox boundary.

### Scope and boundaries

Deliver:
- Three identifiable provider cards, explicit supported/blocked reasons, connect/check/disconnect operations, local login instructions, model selection, and restart-persistent binding metadata.
- Codex and Antigravity CLI adapters using their supported protocols; Claude Code adapter once its policy gate passes, otherwise a real disabled adapter with a documented block reason, not a fake success.
- One normalized text completion contract and wiring to PM plan generation for runtime-verified adapters.
- Unit/integration tests that run without accounts, plus opt-in owner-authorized live tests.

Do not deliver or imply:
- General OpenAI-compatible endpoints backed by stolen/repurposed subscription tokens.
- OAuth reverse engineering, browser-cookie scraping, reading Hermes OAuth, copying another application's account cache, or embedding vendor client IDs.
- A complete engineer/QA autonomous loop, production credential sandboxing proven by fixture tests, or all three live accounts verified without the owner logging in.
- Web-triggered arbitrary shell execution or credentials in a public Next.js endpoint.

### Fixed security and product decisions

1. Official CLI manages login, logout and token refresh; Nail never parses access/refresh tokens. Owner completes login on the connector host. Website displays instructions and a Check connection button, not a general terminal or credential-upload form.
2. Binding IDs match `^[a-z0-9][a-z0-9_-]{0,63}$`; they resolve only through an administrator-owned connector config. HTTP cannot supply HOME, executable, socket, arguments, environment, working directory, or filesystem paths.
3. Connector socket parent mode `0700`, socket mode `0600`; only the owner/service user can reach it. Connector is a separate service with no database access or Nail environment secrets. Binding homes are separate from the application repo, sandbox storage, SSH keys, and personal shell home.
4. A dedicated binding home is initialized by the owner using the official client. Do not rewrite the user's global CLI settings. Do not log out the owner's unrelated personal client when disconnecting Nail: disconnect detaches the binding; explicit separate local CLI logout revokes it.
5. Subprocesses use `spawn(executable, argv, { shell: false, detached: true, ... })` on Linux. Prompt uses stdin, never a shell interpolation or process-list-visible argument. Kill the whole process group on abort/timeout/output overflow: TERM, wait 2 seconds, KILL, await close. One active invocation per binding, no automatic retries.
6. Probe limits: 10 seconds, combined output 64 KiB. Generation limits: 120 seconds, combined output 1 MiB, prompt UTF-8 64 KiB. API request body limit 16 KiB. Bounded streaming reads must not trust Content-Length.
7. Environment is constructed from an allowlist, not copied from `process.env`. Allow only required runtime PATH/HOME/temp/locale/TLS configuration and the binding-specific vendor home variable. Strip API keys, API base overrides, custom gateway/config injection, cloud-provider credentials, proxy credentials, `NODE_OPTIONS`, and all `NAIL_*`, owner/session secrets. Subscription mode must fail if API-key billing is detected; no automatic billing/provider fallback.
8. Connection status distinguishes auth and execution: `not_installed`, `needs_login`, `connected`, `ready`, `rate_limited`, `unavailable`, `unsupported`. Existing provider `status` maps conservatively: only execution-ready maps to `ready`; connected-but-blocked maps to `unavailable`. Detailed reason lives in safe binding diagnostics.
9. Tools, MCP, plugins, hooks and project instructions must not execute in the text-only connector. Empty CWD and prompts saying 'do not use tools' are **not** enforcement. Prove vendor controls plus an OS-level filesystem boundary; if enforcement is unavailable, allow connection diagnostics but disable generation with `tool_isolation_unverified`.
10. CLI status and exit code alone do not prove usable subscription access. Readiness needs permitted auth mode, supported protocol/version, verified isolation, model validation, and a successful opt-in text probe. Store diagnostics separately; public GET does not run probes.
11. Subscription quota is not USD and does not mean unlimited/free. Usage and unknown cost remain explicit. No claimed hard token cap unless the vendor enforces it; PM generation with a finite token budget is blocked when that budget cannot be enforced.

## Exact contracts

Create `lib/domain/subscription-provider.ts` with this public contract (complete code):

```ts
export const SUBSCRIPTION_PROVIDER_KINDS = [
  "antigravity", "codex", "claude",
] as const;
export type SubscriptionProviderKind =
  (typeof SUBSCRIPTION_PROVIDER_KINDS)[number];
export type ConnectionState =
  | "not_installed" | "needs_login" | "connected" | "ready"
  | "rate_limited" | "unavailable" | "unsupported";
export interface ConnectionDiagnostic {
  kind: SubscriptionProviderKind;
  state: ConnectionState;
  reason: string | null;
  model: string | null;
  checkedAt: string;
}
export interface SubscriptionCompletionInput {
  bindingId: string;
  prompt: string;
  model: string;
  maxOutputTokens: number;
}
export interface SubscriptionCompletion {
  text: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  finishReason: "stop";
}
export interface SubscriptionConnector {
  check(bindingId: string, signal: AbortSignal): Promise<ConnectionDiagnostic>;
  cancel(bindingId: string, signal: AbortSignal): Promise<void>;
  complete(input: SubscriptionCompletionInput, signal: AbortSignal):
    Promise<SubscriptionCompletion>;
}
```

Error contract: `SubscriptionProviderError` in `lib/server/providers/subscription-errors.ts`, constructor `(code: SubscriptionErrorCode)`, internally maps safe fixed messages and HTTP statuses; no raw stderr or causes in JSON/logs. Codes: `not_installed`, `needs_login`, `wrong_auth_mode`, `unsupported_version`, `policy_unverified`, `tool_isolation_unverified`, `budget_unenforceable`, `invalid_model`, `rate_limited`, `unavailable`, `invalid_output`, `cancelled`, `timeout`, `output_limit`, `busy`, `invalid_binding`.

Connector wire protocol: one JSON request and one JSON response per Unix-socket connection, terminated by newline. Requests are `{v:1, op:"check", bindingId}`, `{v:1, op:"cancel", bindingId}`, or `{v:1, op:"complete", bindingId, prompt, model, maxOutputTokens}`. Cancellation is idempotent, terminates and awaits the active binding invocation, and returns `{v:1,ok:true,result:null}`. Responses otherwise are `{v:1, ok:true, result}` or `{v:1, ok:false, code}`. Request max 96 KiB; response max 1 MiB. Disconnect cancels the underlying invocation. No raw CLI streams cross this socket. Bindings and limits are resolved server-side. Do not introduce HTTP/TCP transport in v1.

## Step-by-step tasks

Tasks below are narrow implementation slices. Each should take approximately 2–5 minutes of focused work **after its prerequisites are available**. Discovery, owner login, and OS containment validation are release gates, not time-boxed promises. Split a task further if it grows; do not skip its test gate.

### Shared TDD/commit procedure for Tasks 2–18

For each task: write the named tests before changing production code; execute the exact focused command below and confirm assertion failure or missing exported module; implement the specified contract minimally; repeat the command and require exit 0. Then run `bun run test` and require no failed test files before committing **only that task's files** with the indicated message. If Bun is unavailable, use `./node_modules/.bin/vitest run` (or `../../node_modules/.bin/vitest run` when using the existing parent dependency installation); do not create a second lockfile. A passing import-only/type test is insufficient evidence of runtime behavior.

No commit/push is performed in this planning turn. Implementation commits are local; merging/pushing remains a separate decision.

### Task 1 — Resolve official-client and policy gates (read-only first)

Files to create during implementation: `docs/providers/subscription-compatibility.md`.

Run on the intended connector host:

```sh
command -v agy
command -v codex
command -v claude
agy --version
agy --help
codex --version
codex exec --help
codex login --help
claude --version
claude --help
claude auth --help
```

Expected: either installed executable/version/help, or explicitly record missing; do not fabricate versions or install automatically. Retrieve current official authentication, automation, headless output, auth-status, permissions and terms documentation for each provider. Record exact URLs, retrieval date, supported version and **exact argv/stdin/auth-mode/status schema**. For Claude, confirm the specific subscription-through-official-CLI integration is permitted; do not substitute API/SDK authorization for subscription authorization. For Antigravity, follow Authenticate link from the successfully retrieved quickstart; never invent `agy login` or reuse Gemini CLI login commands.

Write one compatibility record per provider with `connectionSupported`, `completionSupported`, auth command/status schema, exact authenticated-home setup, model discovery/validation, tool isolation, token-cap enforcement and blocking reason. A missing required fact produces an explicit block, not a guessed adapter implementation. Verify live docs override stale skills. Commit message: `docs: record subscription client compatibility gates`.

### Task 2 — Preserve baseline and add provider contracts

Before edits: run `git status --short`, `bun run test`, `bun run lint` in the feature worktree. Preserve the existing DeepSeek changes in a dedicated reviewed local commit; do not mix them into this feature or stage the parent tree. If a baseline fails, record it and resolve/ask before attributing failures to new changes.

Create `lib/domain/subscription-provider.ts` using the complete contract above; create `lib/server/providers/subscription-errors.ts`. Test `tests/domain/subscription-provider.test.ts` validates exactly three kinds and fixed safe errors for every code, including malicious stderr/token-like input never becoming a public message. Verify: `bun run test -- tests/domain/subscription-provider.test.ts`; expected all tests pass. Commit: `feat: define subscription provider contracts`.

### Task 3 — Persist stable provider kinds and bindings

Modify `lib/server/db/migrations.ts`, `lib/server/db/repositories.ts`; extend `tests/server/db/database.test.ts`; add `tests/server/providers/subscription-bindings.test.ts`.

Append migration version **8**, do not edit migrations 1–7. Add nullable `providers.kind TEXT` with CHECK allowing `deepseek`, `antigravity`, `codex`, `claude`; backfill only recognized DeepSeek rows from name, leaving unknown legacy kinds null. Add `provider_account_bindings(provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE, binding_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, reason TEXT, checked_at TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0))`. Kind identifies the adapter; binding table contains no credentials or paths. Add a partial unique index on `providers(kind) WHERE auth_mode='subscription_cli'`; transactionally create one subscription provider/binding. On legacy subscription rows, leave them unavailable until explicitly reattached; never infer an account from a display name.

Expose `accountBindings.create/getByProviderId/updateDiagnostic/delete` through repositories. Test migration twice, existing DeepSeek retention, invalid kinds, concurrent duplicate setup using separate SQLite connections, binding uniqueness, parameterized lookup, cascade delete, and no secret material. Verify: `bun run test -- tests/server/db/database.test.ts tests/server/providers/subscription-bindings.test.ts`. Commit: `feat: persist subscription provider bindings`.

### Task 4 — Validate connector administrator configuration

Create `worker/providers/connector-config.ts`; test `tests/worker/providers/connector-config.test.ts`.

Export `loadConnectorConfig(environment: NodeJS.ProcessEnv): ConnectorConfig`. Read `NAIL_CONNECTOR_SOCKET` and `NAIL_CONNECTOR_BINDINGS_FILE` in connector startup only. Config version 1 contains binding IDs with `{kind, executable, home, model, enabled}`; all paths must be absolute, canonical and owner-controlled, with no symlink escapes or group/world write access. Executable comes from an admin allowlist, not PATH supplied by browser. Reject duplicate IDs, invalid kind, writable executable/config, missing home, unsupported version, personal-home overlap and any credential directory under workspace/sandbox roots. Keep deployment values outside SQLite and GET responses.

Test valid temp configuration and all rejections using real temporary files under `TMPDIR`. Verify: `bun run test -- tests/worker/providers/connector-config.test.ts`. Commit: `feat: validate subscription connector configuration`.

### Task 5 — Add bounded subprocess lifecycle

Create `worker/providers/process-runner.ts`; test `tests/worker/providers/process-runner.test.ts`; test fixtures `tests/fixtures/provider-cli/process.cjs`.

Export `runProviderProcess(spec: {executable:string; args:string[]; cwd:string; env:NodeJS.ProcessEnv; stdin:string; timeoutMs:number; maxOutputBytes:number}, signal:AbortSignal): Promise<{stdout:string; stderr:string; exitCode:number}>`. Use the lifecycle/limits fixed above. Child fixture modes: echo stdin as JSON; delayed exit; spawn descendant and hang; emit oversized output; nonzero exit. No real vendor binaries in unit tests.

Assert shell metacharacters in stdin remain data, API-key env is absent, output limits count UTF-8 bytes across stderr/stdout, abort-before-spawn starts nothing, active abort/timeout kills descendants, no unresolved timers/listeners, and cleanup waits for process close. Verify: `bun run test -- tests/worker/providers/process-runner.test.ts`. Commit: `feat: bound subscription client processes`.

### Task 6 — Enforce text-only isolation profiles

Create `worker/providers/isolation-profile.ts`; test `tests/worker/providers/isolation-profile.test.ts`; document verified profiles in `docs/providers/subscription-compatibility.md`.

Export `resolveIsolationProfile(bindingId: string): VerifiedIsolationProfile | null`. Profile validation must tie the verified CLI binary/version, dedicated home and OS service containment to the configured binding; profiles cannot be selected by a request. Prove provider native tools, MCP, hooks/plugins and project configuration cannot execute using the exact controls established in Task 1. Keep CWD empty and read-only; expose no source repo, Nail environment, SQLite, secret-store key or unrelated home. Auth network must remain available; untrusted command network remains in the existing separate sandbox. Deny native host writes outside vendor-owned credential refresh storage.

Negative canary tests attempt file write, command execution, MCP loading, project hooks and secret-path reads; require hard denial. If a client has no supported enforcement path on this deployment, `complete` returns `tool_isolation_unverified` before model invocation, while `check` can still report `connected`. Do not fall back to full-access/bypass flags or assume prompts are security. Verify: `bun run test -- tests/worker/providers/isolation-profile.test.ts`. Commit: `feat: gate subscription inference on verified isolation`.

### Task 7 — Parse Codex noninteractive protocol

Create `worker/providers/codex-protocol.ts`; test `tests/worker/providers/codex-protocol.test.ts`.

Export `parseCodexCompletion(jsonl: string, exitCode: number): SubscriptionCompletion`. Use JSONL events from the pinned official CLI: terminal `item.completed` agent message and terminal `turn.completed.usage`; do not return reasoning, command output, or progress as answer. Model comes from the selected validated binding, not a hard-coded model name; adjust signature to `(jsonl, exitCode, selectedModel)` in both declaration and tests. Reject malformed/oversized frames, failed/incomplete turns, duplicate terminal events, forbidden tool events and exit nonzero even if earlier text exists. Missing usage stays null, not zero. Unknown additive progress events may be ignored; unknown terminal schema fails closed.

Canonical test event sequence:

```jsonl
{"type":"thread.started","thread_id":"test-thread"}
{"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"NAIL_OK"}}
{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}
```

Verify: `bun run test -- tests/worker/providers/codex-protocol.test.ts`. Expected answer `NAIL_OK`, usage 12/3; malformed/error/tool sequences reject. Commit: `feat: parse Codex subscription output`.

### Task 8 — Implement Codex account adapter

Create `worker/providers/codex-adapter.ts`; test `tests/worker/providers/codex-adapter.test.ts`.

Adapter uses the injectable runner, binding config and Task 7 parser. Probe with official `codex login status` under the dedicated `CODEX_HOME`; verify the pinned output/auth mechanism from Task 1 reports ChatGPT, not API key. Configure/enforce official `forced_login_method = "chatgpt"` for the dedicated home. Completion uses pinned `codex exec --json --ephemeral --sandbox read-only -` with stdin prompt plus verified config overrides from Tasks 1/6; never `danger-full-access`. Use explicit model validated by official installed-client facilities. Do not read `auth.json` yourself.

Test connected/missing/login expired/API-key mode, unsupported CLI, model invalid, cancellation, no automatic retry/fallback, and blocked isolation/budget before invocation. If no verified hard output-token cap exists, reject finite-budget plan completion with `budget_unenforceable`; connection itself remains available. Verify: `bun run test -- tests/worker/providers/codex-adapter.test.ts`. Commit: `feat: connect ChatGPT subscription through Codex CLI`.

### Task 9 — Parse Antigravity output

Create `worker/providers/antigravity-protocol.ts`; test `tests/worker/providers/antigravity-protocol.test.ts`.

Export `parseAntigravityCompletion(jsonl:string, exitCode:number, selectedModel:string): SubscriptionCompletion`. Use stream events `init`, `step_update`, terminal `result.result`; terminal requires status `SUCCESS`, string `response`, exit 0 and no forbidden tool events. `WAITING`, `RUNNING`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID` do not count as success. Do not double-count `text_delta` and final response. Single-turn sessions only; usage comes from the final result once, because multi-turn stream counters are cumulative.

Canonical terminal fixture:

```json
{"event":"result","result":{"conversation_id":"test","status":"SUCCESS","response":"NAIL_OK","num_turns":1,"usage":{"input_tokens":12,"output_tokens":3}}}
```

Verify: `bun run test -- tests/worker/providers/antigravity-protocol.test.ts`. Commit: `feat: parse Antigravity headless output`.

### Task 10 — Implement Antigravity account adapter

Create `worker/providers/antigravity-adapter.ts`; test `tests/worker/providers/antigravity-adapter.test.ts`.

Use official **`agy`**, never treat the IDE launcher `antigravity` or Gemini CLI as equivalent. Require verified personal OAuth account mode; use exact auth diagnostics from Task 1. Use `agy models` for selected slug validation. For prompt privacy and predictable parsing, use documented stdin streaming invocation:

```text
argv: ["--input-format","stream-json","--output-format","stream-json","--model", selectedModel]
stdin: JSON.stringify({event:"user",message:{content:prompt}}) + "\n"
```

Close stdin after one prompt and wait for terminal result/close. Supply verified sandbox and deny-all tool/profile settings from Task 6; never `--dangerously-skip-permissions`. Distinguish key-based/enterprise mode from the requested personal subscription binding. An `agy` alias using API-key mode is not subscription readiness.

Test OAuth/key-mode separation, missing CLI, unavailable model, terminal states, soft tool denial versus successful text response, and blocked isolation/budget. Verify: `bun run test -- tests/worker/providers/antigravity-adapter.test.ts`. Commit: `feat: connect Antigravity personal account through agy`.

### Task 11 — Parse Claude Code output

Create `worker/providers/claude-protocol.ts`; test `tests/worker/providers/claude-protocol.test.ts`.

Export `parseClaudeCompletion(json:string, exitCode:number, selectedModel:string): SubscriptionCompletion`. For the pinned documented JSON format require `type:"result"`, `subtype:"success"`, `is_error !== true`, valid text `result`, normal terminal stop and exit 0. Error/budget/max-turn envelopes, missing result, rate limits and malformed usage reject or map to a fixed safe error. Do not infer actual quota or subscription price from `total_cost_usd`; preserve usage fields when available, otherwise null. Validate against the actual Task 1 version before accepting fixture schema.

Verify: `bun run test -- tests/worker/providers/claude-protocol.test.ts`. Commit: `feat: parse Claude Code result envelopes`.

### Task 12 — Implement policy-gated Claude subscription adapter

Create `worker/providers/claude-adapter.ts`; test `tests/worker/providers/claude-adapter.test.ts`.

Default block is `policy_unverified` until Task 1 establishes an authorized integration route. If verified, use official Claude Code subscription login and `claude auth status` under the dedicated home/config, with no API key, Vertex, Bedrock, custom endpoint or API fallback. Candidate headless invocation from the local skill is `claude -p --output-format json --tools "" --max-turns 1 --no-session-persistence`; prompt must arrive over stdin and this exact behavior must be confirmed by the pinned official CLI. Do not use `--bare` because the skill states it skips OAuth; do not use `setup-token` as a generic API key or repurpose OAuth against Anthropic API. Disable all MCP/plugins/hooks via documented controls in addition to native tools; block if they cannot be disabled.

Test default policy block, successful verified profile, wrong billing mode, expired login, failed terminal result, no billing/model fallback and missing token cap. Verify: `bun run test -- tests/worker/providers/claude-adapter.test.ts`. Commit: `feat: add policy-gated Claude Code account connection`.

### Task 13 — Add local connector and client

Create `worker/providers/connector-server.ts`, `worker/providers/index.ts`, `lib/server/providers/subscription-connector-client.ts`; tests `tests/worker/providers/connector-server.test.ts`, `tests/server/providers/subscription-connector-client.test.ts`.

Implement the exact Unix protocol above using `node:net`; dispatch by administrator binding kind. Startup rejects unsafe existing socket paths/symlinks, does not unlink unrelated files, applies socket permissions, and cleans up only its owned socket. Validate body/types/exact fields before dispatch. One active invocation per binding, return `busy` for a second; cancelled client disconnect aborts and cleans up. Client exports `createSubscriptionConnectorClient(socketPath:string): SubscriptionConnector`; same framing/limits/deadlines; no server error leaks raw stdout/stderr. Server startup does not log account credentials or auto-login.

Test actual temp Unix sockets and actual fake child processes, not only mocked calls. Verify: `bun run test -- tests/worker/providers/connector-server.test.ts tests/server/providers/subscription-connector-client.test.ts`. Commit: `feat: add private subscription connector transport`.

### Task 14 — Add provider registry and budget accounting

Create `lib/server/providers/provider-registry.ts`, `lib/server/providers/subscription-adapter.ts`; test `tests/server/providers/provider-registry.test.ts`, `tests/server/providers/subscription-usage.test.ts`.

Registry dispatches on `kind` + `authMode`, not display name. DeepSeek continues using `DeepSeekAdapter`; subscription rows require null `secretReference` and an account binding. Export `completeProviderText(database, providerId, runId, prompt, maxOutputTokens, signal, dependencies): Promise<SubscriptionCompletion>` for PM text. Check runtime readiness and enforceable finite budget before reserving; reserve via `reserveProviderRequest` before external call, settle via `completeProviderUsage` exactly once. Error/cancel settles unknown conservatively; do not refund a request that may have reached the provider. Missing usage is null and charged at reserved token bound, never zero. CLI-reported over-cap output remains blocked/charged; do not return it as compliant output. Retain unknown monetary cost; never present CLI cost estimates as subscription billing.

Tests: display-name change still routes correctly; DeepSeek regression; subscription never reads secret store; missing binding; insufficient request/token budget results in no child; provider rejection, cancellation, and unknown usage charge conservatively; over-reported tokens fail closed. Verify: `bun run test -- tests/server/providers/provider-registry.test.ts tests/server/providers/subscription-usage.test.ts`. Commit: `feat: route provider text with conservative subscription budgets`.

### Task 15 — Add owner-only connection endpoints

Create `lib/server/providers/subscription-handlers.ts`; routes `app/api/providers/subscriptions/route.ts`, `app/api/providers/[providerId]/connection/route.ts`; extend safe provider list in `lib/server/dashboard/read-api.ts`; test `tests/server/providers/subscription-handlers.test.ts`.

Contract:
- `POST /api/providers/subscriptions`: exact `{kind,bindingId,model}`; admin binding kind/model must match. Create unavailable subscription row/binding, probe through connector, persist diagnostic; only verified readiness changes status to ready. Duplicate kind returns 409.
- `POST /api/providers/:providerId/connection`: exact `{action:"check"}` or `{action:"disconnect"}`. Check explicitly probes; disconnect removes Nail binding, marks provider `not_configured`, aborts active connector work for the binding and prevents a late check from restoring ready (use revision/CAS). Does not delete vendor home or revoke another app login.
- `GET /api/providers` remains a read-only SQLite operation; add `kind` and safe connection object `{state,reason,checkedAt}`. Do not expose binding paths/IDs, executable, stdout, account email, secret reference or tokens.

All mutations: existing owner auth then `isSameOriginRequest`, JSON-only, bounded streaming body, exact field validation, `cache-control:no-store`, unknown provider 404. Browser cannot select command/path/config; no 'run CLI' endpoint. Fixed error codes only. Test real auth login/cookie at least once, plus unauthenticated/cross-origin/malformed/oversized/injected paths, duplicate kinds, disconnect-vs-late-check race, connector down, and no sensitive GET/POST fields. Verify: `bun run test -- tests/server/providers/subscription-handlers.test.ts tests/server/dashboard/read-api.test.ts`. Commit: `feat: expose owner-only subscription connection controls`.

### Task 16 — Add subscription cards in Providers UI

Create `app/subscription-provider-panel.tsx`, `app/subscription-provider-client.ts`; modify `app/providers/page.tsx`; tests `tests/ui/subscription-provider-panel.test.tsx`, `tests/ui/subscription-provider-client.test.ts`.

Keep existing DeepSeek form/list intact. Render Antigravity, Codex Subscription, Claude Subscription cards; model field, safe binding ID field (not path), local official login instructions, Check connection, Disconnect, loading/error state and truthful blocked reason. No password/token inputs; no 'connected' label based on row existence alone. Use one parent refresh counter/callback rather than expanding global custom-event dependencies. Update list after successful mutation. Block double submission and disable inference selection unless ready; show `Terhubung, belum siap digunakan` for connected-but-policy/isolation/budget blocked. Add `data-testid` only where selectors otherwise cannot be stable.

Test all state renderings via React server-rendered markup consistent with existing UI tests; separately test actual client request payloads/errors using injected fetch. Browser interaction evidence remains Task 19, not implied by static markup tests. Verify: `bun run test -- tests/ui/subscription-provider-panel.test.tsx tests/ui/subscription-provider-client.test.ts tests/ui/dashboard-components.test.tsx`. Commit: `feat: add subscription account connection UI`.

### Task 17 — Route PM plan requests through the registry

Modify `lib/server/orchestration/run-request.ts`; create `lib/server/orchestration/provider-plan-generator.ts`, `lib/server/orchestration/run-request-handler.ts`; modify `app/api/projects/[projectId]/runs/route.ts` to add POST without changing GET. Tests `tests/server/orchestration/provider-plan-generator.test.ts`, extend `tests/server/orchestration/run-request.test.ts`, create `tests/server/orchestration/run-request-handler.test.ts`.

Replace hard-coded DeepSeek readiness with kind/auth/registry compatibility. Keep injected `PlanGenerator` for tests. `createProviderPlanGenerator(database, dependencies): PlanGenerator` constructs a text-only JSON instruction containing only goal/baseline/allowed tools/safe agent IDs+roles; do not send source files, instructions containing secrets, system env or credential paths. Parse one JSON object (no markdown extraction, auto-repair or retries), return unknown to existing `proposePlanForApproval` for exact-field/DAG/owner validation. A model proposes tools; it must never execute them during PM planning.

POST body is existing `CreatePlanRequest` fields except `projectId` from route params. Auth/origin/JSON/size validation before creation; ready provider only; return 201 with safe run ID/plan/approval data. Invalid request 400, unavailable provider/config 503, unknown project 404. Rejected generated plan must leave run failed and never queued; successful result stops at awaiting approval. Do not auto-approve or claim execution.

Use this valid model proposal fixture, with an actual `engineer-1` agent seeded in SQLite:

```json
{"goal":"Add a health endpoint","acceptanceCriteria":[{"id":"ac1","description":"Health endpoint returns 200"}],"subtasks":[{"id":"task1","title":"Add health handler","description":"Implement the approved health route","ownerAgentId":"engineer-1","dependsOn":[],"requiredTools":[]}]}
```

Verify: `bun run test -- tests/server/orchestration/provider-plan-generator.test.ts tests/server/orchestration/run-request.test.ts tests/server/orchestration/run-request-handler.test.ts tests/server/orchestration/orchestration.test.ts`. Test each kind through a fake connector, unsupported/blocked kind no invocation, malformed proposal, budget rejection, no account change or fallback. Commit: `feat: generate approval-bound plans with registered providers`.

### Task 18 — Add user setup and operational documentation

Modify `README.md`; create `docs/providers/subscription-accounts.md`, `scripts/subscription-provider-smoke.mjs`; test `tests/server/providers/subscription-smoke.test.ts`.

Document dedicated connector user/home setup, official version pins, owner-completed login, configuration permissions, service start/stop/socket health, session refresh and explicit local logout, safe disconnect, quotas and known gates for all three. Exact login commands must be those confirmed in Task 1; unresolved route is marked unavailable, never filled with invented commands. Include Next.js env socket only, no subscription token env fields. Smoke script uses the local connector directly, one specified binding, explicit `--allow-live`, fixed harmless prompt `Reply with exactly NAIL_OK`, timeout and safe output `{kind,state,probePassed}`; exit 0 only for exactly verified success, exit 2 for blocked/skipped/unavailable. Do not print raw output, paths or tokens; reject missing opt-in before connecting. No normal tests run a real account.

Verify: `bun run test -- tests/server/providers/subscription-smoke.test.ts`; missing `--allow-live` test must start zero subprocesses/socket calls. Commit: `docs: document subscription account operations and smoke tests`.

### Task 19 — Final automated and opt-in acceptance

Before claiming completion, run in feature workspace:

```sh
bun run test
bun run lint
bun run build
node node_modules/next/dist/bin/next build --webpack
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

Expected: full tests green, ESLint exit 0, TypeScript/build exit 0, whitespace exit 0. Run default Turbopack first; if worktree-root dependency resolution still fails, record the failure and use the Webpack command as an explicitly labeled alternative, not proof default build passed. Standalone typecheck follows Next generated-type generation. If wrapper scanning blocks `eslint`, use `node <resolved-node_modules>/eslint/bin/eslint.js .`; do not disable security guards.

With owner's explicit permission, start a private test instance using a scratch SQLite DB and connector configuration, then use browser tooling to test login, three cards, validation, invalid/expired account states, check/disconnect, page refresh, and PM awaiting-approval result. Inspect console/network errors and record screenshots without secrets under ignored `.hermes/qa/subscription-providers/`; keep report in `docs/providers/subscription-validation.md`. Do not reuse production DB or public credentials.

Owner performs vendor login for each binding; then explicitly authorize one live probe per provider:

```sh
node scripts/subscription-provider-smoke.mjs --binding codex-owner --allow-live
node scripts/subscription-provider-smoke.mjs --binding antigravity-owner --allow-live
node scripts/subscription-provider-smoke.mjs --binding claude-owner --allow-live
```

Expected for supported verified binding: exit 0 and `probePassed:true`. If policy/isolation/budget/login is blocked, expected safe exit 2 plus reason; that is **blocked**, not a successful integration. For a model call, usage may consume subscription quota. Tests may not automatically log in, accept consents, buy plans, or change billing.

Self/fresh review must check all security decisions and sources. Report every skipped live test, policy gate, tool-isolation limit and unsupported version explicitly. Commit only tracked feature/docs files with `test: record subscription adapter verification`; leave integration/merge decision to owner.

## Tests / validation matrix

- Persistence: v7 upgrade, repeat migrate, legacy DeepSeek untouched, stable kind selection, binding uniqueness, disconnect/readiness CAS.
- CLI processes: stdin privacy, no shell, explicit env, timeout/cancel/output bounds, descendant cleanup, no retries/billing fallback.
- Protocols: real documented shapes only; nonzero exit with partial text, duplicate terminal, failed/interrupted state, forbidden tool event and malformed usage all fail closed.
- Billing/auth: subscription login only, API-key/cloud credentials stripped, account expiration => needs login, rate limit => no fallback.
- Boundary: browser cannot start arbitrary processes, connector cannot access Nail credentials/database/repo, untrusted repo sandbox cannot access account credentials.
- PM: all compatible kinds route through registry, finite reservations before call, unknown usage conservative, valid plan awaits owner approval, no task execution during planning.
- UI: safe metadata only, explicit unavailable states, restart/refresh preserve bindings, disconnect does not log out unrelated personal clients.
- Live: one owner-authorized harmless call per provider; distinguish account-connected from generation-ready. No live account evidence means no claim all three providers work.

## Risks, tradeoffs and open questions

1. **Claude policy gate:** live official docs were blocked during planning. An implementer must verify current permitted official-client subscription automation. If disallowed, the requested Claude subscription adapter cannot ship as functional; retain a truthful blocked state and offer a separately approved API-key alternative. Do not silently replace the subscription requirement.
2. **Budget enforcement:** CLIs are agent runtimes, not raw token-capped completion APIs. If any cannot enforce Nail's current hard output-token budget, its connection can ship but PM generation stays blocked. Changing budget semantics requires a separate explicit product decision; time/byte limits are not token caps.
3. **Tool/credential isolation:** host CLI access is not covered by Nail's network-none Docker command sandbox. Vendor permission settings and OS containment must be demonstrated, not inferred from tests or prompts. Some clients may remain connection-only pending a stronger broker profile.
4. **Subscription entitlements:** a successful local login does not establish paid tier, remaining quota, current model availability, or permission for arbitrary hosted automation. Surface observed auth mode and probe state without promising unlimited access.
5. **Version drift:** model names, status outputs and event schemas change. Pin validated versions in connector compatibility records; reject unknown terminal/auth schema. No guessed fixed latest versions or model catalogs.
6. **Host location:** browser login occurs on the connector host; a developer's laptop session is not automatically available on the VPS. No remote token upload is planned. If accounts must stay on a laptop, a separately designed authenticated remote connector is required; v1 Unix socket is host-local only.
7. **DeepSeek dependency:** its setup changes are uncommitted. Preserve them explicitly before implementation so a new branch does not accidentally lose existing work or falsely report them as part of this plan's tests.
8. **Extent of completion:** CLI connection adapters do not finish engineer/QA/patch delivery. This plan ends at safe account connection and approved-plan generation where enabled, not autonomous code execution.
9. **No account pooling:** per-binding serialization is deliberate. Do not rotate accounts after quotas, retry in a different region, reuse another app token cache or change billing mode.
10. **Decisions delegated:** Linux connector deployment, local owner-controlled CLI login, one account per kind, and no browser-hosted OAuth were chosen as conservative defaults. A web-native embedded login flow or multi-user account sharing is a separate design and security review.
