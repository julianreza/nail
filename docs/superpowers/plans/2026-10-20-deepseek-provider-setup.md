# DeepSeek Provider Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner register a usable DeepSeek API-key provider while keeping the key encrypted and server-only.

**Architecture:** A server-side setup service authenticates the key against DeepSeek's bounded `/models` response, verifies the selected model, encrypts the key using the existing secret store, and persists provider metadata. A same-origin owner-only POST endpoint invokes that service; a client form on Providers submits the key and displays safe state.

**Tech Stack:** Next.js 16.4.2 Route Handlers, React 19.3.0, strict TypeScript, built-in `fetch`, SQLite repositories, `EncryptedSecretStore`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-deepseek-provider-setup-design.md`

## Global Constraints

- API keys must never enter SQLite except as encrypted-secret references, browser storage, URLs, logs, or responses.
- Only accept a model returned from authenticated DeepSeek `/models`.
- State-changing requests require owner authentication and exact same-origin validation.
- Preserve the existing provider-list JSON shape and do not expose secret references.
- No new dependencies and no real network or credentials in automated tests.

## Review Focus

- Malformed or oversized provider response: reject without writing secret or DB row.
- Duplicate DeepSeek setup: reject before a second credential is stored.
- Secret write succeeds but DB write fails: remove the orphaned secret.
- Unauthorized, cross-origin, wrong-content-type, or malformed POST: reject without reading/writing provider configuration.
- Key echoed by remote errors or client responses: ensure errors and rendered output never contain it.

---

### Task 1: Provider setup service

**Files:**
- Create: `lib/server/providers/provider-setup.ts`
- Test: `tests/server/providers/provider-setup.test.ts`

**Interfaces:**
- Consumes: `EncryptedSecretStore`, `createRepositories`, and `DatabaseSync`.
- Produces: `createDeepSeekProviderSetup(database, secretStore, input, fetcher?)`, returning safe provider metadata after validation and persistence; typed safe setup errors for invalid input, duplicate provider, invalid credentials, unavailable provider, and unsupported model.

- [ ] Write tests proving a valid key/model is authenticated through HTTPS GET `/models`, encrypted via the existing store, and persisted as a ready DeepSeek API-key provider without exposing the key.
- [ ] Add tests for 401/403, network/5xx, malformed/oversized response, unlisted model, duplicate provider, and rollback when DB persistence fails; verify no residual secret and no DB row.
- [ ] Run `../../node_modules/.bin/vitest run tests/server/providers/provider-setup.test.ts` from the worktree and confirm the missing service causes expected failures.
- [ ] Implement the smallest service satisfying those cases; bound response bytes and use safe error messages.
- [ ] Re-run the focused tests and full test suite.

### Task 2: Owner-only API endpoint

**Files:**
- Modify: `app/api/providers/route.ts`
- Create: `lib/server/providers/provider-setup-handler.ts`
- Test: `tests/server/providers/provider-setup-handler.test.ts`

**Interfaces:**
- Consumes: `isSameOriginRequest`, `EncryptedSecretStore`, the setup service, auth handlers, and injected runtime dependencies.
- Produces: `createProviderSetupHandler(dependencies)(request)` implementing POST status/body contract from the spec.

- [ ] Write tests for unauthenticated, wrong-origin, wrong-content-type, invalid JSON/input, missing database/secrets configuration, successful setup, and secret-free responses.
- [ ] Run the focused test and verify it fails because the handler is absent.
- [ ] Implement the injectable handler and wire it to `POST` in the existing providers Route Handler without changing GET.
- [ ] Re-run focused and full tests.

### Task 3: Providers setup form

**Files:**
- Create: `app/provider-setup-form.tsx`
- Modify: `app/providers/page.tsx`
- Test: `tests/ui/provider-setup-form.test.tsx`
- Modify: `README.md`

**Interfaces:**
- Consumes: `POST /api/providers` returning only safe provider metadata and existing GET `/api/providers` list.
- Produces: labeled key/model inputs, submit state, safe success/error feedback, and refresh of provider list after setup.

- [ ] Write a render test for accessible model/key controls and feedback regions before implementation.
- [ ] Run the focused test and confirm it fails because the form is absent.
- [ ] Implement the client form; clear the key after submission and never persist it in browser storage.
- [ ] Add the form to the existing Providers page and update README setup steps/configuration notes.
- [ ] Run focused UI tests, all tests, ESLint, and production build from the worktree.
