# Nail Agent Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved single-user agent orchestrator in small, verifiable phases, starting with a secure persistent foundation and ending with tested deployment on the target VPS.

**Architecture:** Keep the Next.js App Router as the UI and control plane. Persist application state in SQLite and run agent jobs in a separate, serial worker; execute project commands only inside a resource-limited sandbox on the same VPS. Add provider adapters only after the approval, queue, and sandbox contracts are proven.

**Tech Stack:** Next.js 16.4.2, React 19.3.0, strict TypeScript, Tailwind CSS 4, Bun 1.4.3 (existing). SQLite, test framework, authentication/session implementation, and sandbox runtime are not present yet; select and document them in their owning phase before adding dependencies.

**Spec:** `.hermes/plans/2026-10-19_160725-nail-agent-orchestrator-design.md`

## Global Constraints

- Single-user application; all application and agent execution are targeted to the same Ubuntu VPS with 2 GB RAM and 2 CPU cores.
- The project currently has no backend, database, authentication, runner, or test suite.
- One global agent execution lease; no parallel agent jobs.
- Execution must fail closed when sandbox/resource/network isolation preflight fails; never fall back to running project commands on the host.
- Require explicit approval for execution, changed plans/baselines, expanded permissions, credentials, and cost limits; no automatic commit, push, merge, or deploy of project output.
- Do not collect subscription passwords, cookies, or session tokens in the app; use only official provider authentication flows.
- Keep secrets out of browser responses, prompts, logs, diffs, and exports.
- Do not claim provider, sandbox, or VPS readiness without the corresponding real integration/resource test.
- Preserve existing user changes, `AGENTS.md`, and untracked assets; do not commit, deploy, or alter credentials without a separate explicit request.

## Review Focus

- Database write contention or worker restart while a job holds a lease — prove atomic single-lease acquisition and safe interrupted recovery in the worker/state phase.
- Stale approval or changed repository baseline — prove action fingerprints invalidate approval in the approval/run phase.
- Sandbox cgroup/network isolation unavailable on target Ubuntu — preflight must disable execution and tests must show no host-process fallback.
- Provider auth expiry, rate limits, or unavailable capabilities — adapters must report explicit states and never silently switch billing paths.
- VPS memory/disk exhaustion during dependency install or builds — capacity checks must block execution without destabilizing the host.

---

## Phase 0: Interfaces and test foundation

Deliver a minimal test harness and shared contracts before implementing backend behavior. Keep the starter app buildable throughout.

### Task 1: Add deterministic test tooling

**Files:**
- Modify: `package.json`
- Create: test configuration and a small test under `tests/` (choose filenames after selecting a framework)

**Interfaces:**
- Produces: a documented test command in `package.json` and a working test harness for TypeScript domain modules.

- [ ] Select a test framework compatible with installed Next.js/TypeScript and Bun; add only required dev dependencies and an explicit test script.
- [ ] Add one passing smoke test for a pure domain function and run the exact new script.
- [ ] Run `bun run lint` and `bun run build`.

### Task 2: Define domain contracts

**Files:**
- Create: focused modules under `lib/domain/` for run state, tasks, approvals, provider status, and verification results
- Create: matching tests under `tests/domain/`

**Interfaces:**
- Produces: typed run states exactly as in the design (`draft`, `awaiting_approval`, `queued`, `running`, `awaiting_review`, `blocked`, `interrupted`, `failed`, `done`, `cancelled`); validated task DAG; provider connection states; explicit `verified`/`failed`/`not-run` result states.

- [ ] Test legal and illegal run transitions, cyclic DAG rejection, and provider/result state serialization.
- [ ] Implement types and pure validators; do not add model-generated authority over permissions or status.
- [ ] Run the focused test command, `bun run lint`, and `bun run build`.

## Phase 1: Secure single-user control plane

### Task 3: Owner authentication and protected routes

**Files:**
- Create: server-only auth/session modules and protected route helpers under `lib/server/auth/`
- Modify: `app/layout.tsx` and route files only as required for login/protected views
- Create: auth tests under `tests/server/auth/`

**Interfaces:**
- Produces: server-side session validation and an owner-only access guard used by pages, APIs, and event streams.

- [ ] Select password hashing and session mechanism; test invalid credentials, session expiry, CSRF on mutations, origin checks, login throttling, and unauthenticated stream/API rejection.
- [ ] Implement owner setup without public signup; session cookies must be HttpOnly, Secure in production, and SameSite-protected.
- [ ] Run focused tests and build; verify no credential or session value is rendered to the browser.

### Task 4: SQLite persistence and migrations

**Files:**
- Create: `lib/server/db/` connection, migration, and repository modules
- Create: migration files and `tests/server/db/`

**Interfaces:**
- Produces: repositories for projects, agents, providers (metadata only), conversations, runs, tasks, dependencies, approvals, leases, events, QA results, artifact metadata, and usage records.

- [ ] Select SQLite driver and migration strategy compatible with the worker deployment; enable WAL and configure persistent storage.
- [ ] Test migration from empty DB, atomic writes, event IDs, and persistence after reopening the database.
- [ ] Implement schema/repositories and run migrations in tests; never store plaintext API keys or CLI auth material in ordinary application tables.

### Task 5: UI shell backed by real state

**Files:**
- Modify: `app/page.tsx`, `app/globals.css`
- Create: focused components under `app/` or `components/` and authenticated read APIs under `app/api/`

**Interfaces:**
- Produces: owner-only Overview, Projects, Agents, Tasks, Approvals, Providers, and Settings navigation with truthful empty/loading/error states.

- [ ] Test route access and empty-state rendering from backend responses; no fabricated counts or charts.
- [ ] Implement the approved visual direction: ivory, lime, dark green, pastel sidebar, strong outlines, rounded cards, offset shadows; retain Geist.
- [ ] Check keyboard access and mobile layout; run lint, build, and UI tests.

## Phase 2: Runs, approvals, and serial worker

### Task 6: Approval fingerprints and run transitions

**Files:**
- Create: `lib/server/runs/` approval and transition services
- Create: `tests/server/runs/`

**Interfaces:**
- Produces: server-validated plan approval bound to plan version, baseline, commands, permissions, and cost limits; payload changes invalidate approval.

- [ ] Test exact-match approval, stale-plan rejection, changed-baseline rejection, and forbidden status/permission changes originating from model text.
- [ ] Implement approval service and auditable event records; require explicit approval before any execution.

### Task 7: Persistent queue, lease, and worker lifecycle

**Files:**
- Create: `worker/` entry point and job runner
- Create: `lib/server/queue/` claim/heartbeat/recovery services
- Create: `tests/server/queue/`

**Interfaces:**
- Produces: one global atomic lease, expiring heartbeat, serial task execution, and recovery that marks uncertain work interrupted without replaying commands.

- [ ] Test competing claims, worker crash, stale lease recovery, event reconnect without duplicate work, and cancellation of process trees.
- [ ] Implement worker as a separately managed process; browser disconnection must not stop jobs.
- [ ] Run integration tests against temporary SQLite databases and verify only one job is active globally.

### Task 8: Project workspace and baseline protection

**Files:**
- Create: project repository/workspace service under `lib/server/projects/`
- Create: `tests/server/projects/`

**Interfaces:**
- Produces: per-run isolated working copy, baseline identity, checkpoint/diff records, and setup/verification command allowlist requiring approval.

- [ ] Test baseline change detection, workspace separation between runs, checkpoint creation, and refusal to apply a patch to a different baseline.
- [ ] Implement Git import/empty project handling and workspace lifecycle without auto-commit/push/merge/deploy.

## Phase 3: Sandbox and API-backed agent workflow

### Task 9: Fail-closed resource-limited sandbox

**Files:**
- Create: `worker/sandbox/` runtime interface and implementation
- Create: sandbox preflight and integration tests under `tests/sandbox/`

**Interfaces:**
- Produces: start/stop/inspect sandbox operations with enforced CPU, memory, PID, timeout, filesystem, and network policy.

- [ ] Test preflight failure when cgroup v2/controller delegation is unavailable; assert no host command executes.
- [ ] Test resource limits, non-root execution, denied host/metadata/private-network access, no secrets/control-plane mounts, timeout, cancellation, and process-tree cleanup.
- [ ] Implement rootless Docker only if target host proves cgroup/resource/network controls effective; otherwise keep execution disabled.
- [ ] Validate design defaults: CPU 1 core, RAM 768 MiB, PID limit 128, and 15-minute attempt timeout; document that these are proposed protection limits, not a guarantee projects fit.

### Task 10: Usage-limited API provider and secret broker

**Files:**
- Create: `lib/server/providers/` API adapter, capability checks, encrypted secret storage, and worker broker
- Create: `tests/server/providers/`

**Interfaces:**
- Produces: provider connection state, capability-checked streaming/tool-call interface, request/tool-call/output-token caps, and secret-free worker API.

- [ ] Test unsupported capabilities, 401/429/5xx responses, secret redaction, bounded usage, and no automatic provider/billing fallback.
- [ ] Implement DeepSeek API-key adapter first; keep encryption key outside sandbox and never expose stored secrets to browser or project commands.

### Task 11: PM planning, engineer tasks, QA loop

**Files:**
- Create: `lib/server/orchestration/` plan validation and task scheduling
- Create: `tests/server/orchestration/`
- Modify: authenticated project/run UI components

**Interfaces:**
- Produces: structured PM plan (goal, acceptance criteria, subtasks, dependencies, owners, tools, verification); serial FE/BE tasks; QA findings converted to engineer subtasks; final patch and evidence.

- [ ] Test DAG scheduling, invalid model plans, QA failure routing, three-round limit, required verification gating, and project with no automated checks requiring explicit manual verification.
- [ ] Implement bounded model/tool loop with approvals enforced in server services, not by UI or model prompt.
- [ ] Test fixture end-to-end: request → plan → approve → FE → BE → QA fail → repair → QA pass → diff/evidence.

### Task 12: Logs, artifacts, events, and limits

**Files:**
- Create: `lib/server/events/`, log/artifact storage modules, and retention jobs
- Create: `tests/server/artifacts/`

**Interfaces:**
- Produces: resumable monotonic event stream, paginated/truncated logs, retained final artifacts, and bounded transient storage.

- [ ] Test reconnect cursor, 10 MiB per-run active log cap, output truncation metadata, 14-day terminal transient retention, disk-full handling, and final artifact retention until user deletion.
- [ ] Ensure logs never contain provider secrets and UI distinguishes verified, failed, and not-run results.

## Phase 4: Official native CLI adapters

### Task 13: Adapter contract and capability enforcement

**Files:**
- Create: `lib/server/providers/cli-adapter.ts` (or equivalent typed interface)
- Create: deterministic contract tests under `tests/server/providers/`

**Interfaces:**
- Produces: official-runtime adapter contract for authentication state, tool permissions, command recording, resume, cancellation, and capability reporting.

- [ ] Test that an adapter missing any required permission, audit, cancellation, or approval capability remains unavailable; do not enable permission bypass.
- [ ] Implement adapter lifecycle without app-owned subscription token collection or automatic billing fallback.

### Task 14: Codex, Claude Code, and Antigravity adapters

**Files:**
- Create: one adapter module per provider and provider-specific integration tests/docs

**Interfaces:**
- Produces: separately validated adapters using each provider's official login/runtime flow; CLI auth lives in a restricted runtime volume, not the app's API-key table.

- [ ] Implement and smoke-test one provider at a time with user-owned credentials; verify auth expiry, rate limits, streaming, tool permissions, resume, cancellation, and resource limits.
- [ ] Keep untested providers visibly unavailable; never claim a fixture test proves live provider connectivity.
- [ ] Validate the limits of credential isolation from child tools before allowing untrusted projects to use subscription CLI modes.

## Phase 5: VPS readiness and recovery

### Task 15: Deployment, backup, and capacity validation

**Files:**
- Create: deployment/service configuration, operator documentation, backup/restore scripts, and target-host tests

**Interfaces:**
- Produces: private HTTPS owner deployment with managed web/worker/rootless runtime services, recoverable DB/artifacts/auth storage, and verified resource preflight.

- [ ] Confirm target Ubuntu version, CPU architecture, disk, swap, cgroup v2, controller delegation, domain, and available credentials before deployment work.
- [ ] Test consistent SQLite backup/restore with WAL, artifact/auth volume permissions, restart reconciliation, host/private-network blocking, and disk-full behavior.
- [ ] Load-test one real bounded job on the target VPS; prove app responsiveness and clean cancellation under limits before claiming readiness.
- [ ] Run full automated suite and live provider smoke tests; report unsupported project sizes/providers as blocked rather than weakening limits.

## Execution order and handoff

Implement phases sequentially. A later phase may begin only after the prior phase's tests pass and its security assumptions are verified. Treat each task as a reviewable change; do not commit unless explicitly requested. Provider policy, VPS capacity, and security controls require live evidence, not design-time claims.
