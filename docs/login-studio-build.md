# Login studio layout — build-only update

Build source: `feature/reference-theme` worktree, base `646b500`; uncommitted at build time. The owner subsequently authorized committing and merging the combined theme/login changes to `main` without rerunning tests.

## Changes

Desktop login now uses a two-panel composition: an emerald editorial/brand panel with lime headline, decorative orbit illustration and project/agent/approval chips; and a white owner-login panel with a shield emblem, clear password field and lime submit button. Below 820px, the decorative panel is hidden and the form remains a single compact column. No authentication API, form submission logic, credential or persistent data change was made.

## Verification scope

The preceding owner request to skip tests and build directly was retained for this visual refinement. Vitest, lint, browser interaction assertions and Docker integration smoke were not run. `docker build --target app -t nail-app:login-studio-1 .` passed, including the built-in Next.js production build/TypeScript step.

Actual desktop (1440x1000) and mobile (390x844) screenshots of the public login page were captured without credentials and visually inspected. This is a visual inspection, not a login/session regression test. App health is healthy and public HTTPS `/login` returned 200.

## Deployment

Only the app container was replaced with `nail-app:login-studio-1`. Connector/proxy containers and database/secret volumes remain unchanged. Prior image `nail-app:color-refinement-1` and Compose rollback copy `/home/ubuntu/nail-deploy/compose.before-login-studio.yaml` are retained. Git integration does not recreate this deployed container.
