# DeepSeek Provider Setup

## Intent
Let the workspace owner configure the first usable DeepSeek API provider so future orchestration runs can select it without ever persisting or exposing a plaintext API key.

## Goals
- Provide an owner-only form on the Providers page for an API key and a supported model.
- Validate the credential against DeepSeek before saving it, using the lightweight model-list endpoint rather than a billable completion.
- Store the key only through the existing AES-GCM `EncryptedSecretStore`; persist only its secret reference in SQLite.
- Make setup idempotent at the UI/API level by rejecting a second active DeepSeek provider rather than creating ambiguous choices.
- Return safe provider metadata and status; never echo the submitted key or encrypted reference.
- Keep provider request and response handling no-store and protect state-changing requests with owner auth and exact same-origin checks.

## Non-goals
- Editing, rotating, or deleting an existing provider.
- Supporting providers other than DeepSeek or subscription/CLI authentication.
- Starting agent runs or changing the orchestration loop.
- Verifying billing, model quality, or tool-call capability through an inference request.

## Constraints
- Keep the current stack and dependency set; use Next.js App Router Route Handlers and existing React/Vitest patterns.
- The server reads `NAIL_DATABASE_PATH`, `NAIL_SECRET_DIR`, `NAIL_SECRET_ENCRYPTION_KEY`, and `APP_ORIGIN` from server-only environment variables.
- Use `EncryptedSecretStore` for secret persistence; do not put keys in SQLite, logs, query strings, errors, or browser storage.
- Only accept model IDs advertised by the authenticated DeepSeek `/models` response, with a bounded response body and strict parsing.
- Do not save a key when authentication, network, model selection, or environment configuration fails.
- Preserve current provider-list response shape and its omission of `secretReference`.

## Approach
Add a server-side provider-setup service with injected fetch, secret store, database, and origin. The service validates input, confirms the model is advertised by DeepSeek using a no-redirect HTTPS GET, encrypts the key, then creates the provider row; if persistence fails it deletes the newly written secret. Add an authenticated POST to `/api/providers` that checks exact same-origin and JSON content type, converts environment/setup failures to safe responses, and does not include secret material in errors. Add a client form to the existing Providers page that reports success/failure, clears the key after submission, and reloads the safe provider list.

## Acceptance criteria
1. A valid owner request with a valid DeepSeek key and advertised model creates one ready API-key provider and returns no key or secret reference.
2. Missing/invalid fields, wrong origin, unauthenticated requests, invalid credentials, unavailable provider, unadvertised model, and missing secret-store configuration do not create a provider.
3. Keys are encrypted at rest with owner-only file permissions and are absent from response data and persisted provider rows.
4. The Providers page exposes labeled model/key controls, a pending state, success/error feedback, and a provider list without secret details.
5. Automated tests exercise service behavior, auth/origin behavior, and UI form behavior without real credentials or network calls.

## Assumptions
- Model IDs are selected from the live `/models` response, rather than relying on a hard-coded list that may become stale.
- A configured provider is considered ready once DeepSeek accepts the authenticated model-list request and the selected model is present.
- The UI presents setup controls only when no DeepSeek provider exists; provider rotation remains a separate feature.
