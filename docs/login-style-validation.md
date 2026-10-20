# Login visual alignment validation

Source worktree: `/home/ubuntu/Project/nail/.worktrees/login-style`, branch `feature/login-style`, based on `8bd2efd`. Changes are not committed or merged; the running app image contains this worktree's login UI changes. No authentication API, credential, session, database or dashboard behavior was changed.

## Changes

- Reuse dashboard brand mark and existing background/foreground/lime/lavender/peach/muted CSS variables.
- Center the owner login card with dark 2px borders, offset shadows, lavender header and lime submit button.
- Keep owner-only access text, explicit password label/autocomplete, required validation and existing submit/error logic.
- Add linked password guidance, form busy state, responsive spacing, 48px input/button targets and reduced-motion handling.
- Use route-local `login.css` with namespaced `.login-*` classes. Do not change the project's Tailwind Turbopack rule.

## Executed evidence

- Two new SSR accessibility tests were observed failing before implementation, then passing.
- Full suite: 36 test files, 144 tests passed.
- ESLint and `git diff --check`: passed.
- Docker app production build (default Turbopack and TypeScript): passed.
- Disposable Docker integration smoke with `NAIL_SMOKE_APP_IMAGE=nail-app:login-style-2`: passed, including auth, private connector and SQLite persistence checks.
- Chromium checked rendered styles at 1440x1000, 390x844 and 320x640: cream body, matching lime logo/button, lavender header, dark 2px border, no horizontal overflow, touch target >=44px.
- Chromium checked keyboard focus, disabled pending submit, visible error state, real owner login to dashboard and logout through the public HTTPS URL. No page JavaScript exceptions. Owner credential and cookie values were never printed.
- Desktop and mobile screenshots were visually inspected. Test captures live under the Hermes scratch directory, not committed application assets.

## Build integration finding

The initial CSS Module implementation compiled and passed SSR tests but lost its class mapping under this project's installed catch-all CSS loader rule. A real browser caught the transparent button and absent layout; the first image was rolled back. Namespaced route CSS then passed browser computed-style assertions in an isolated preview before replacement of the live app. This is why static markup/unit/build checks alone do not certify styling.

## Deployed result

App image: `nail-app:login-style-2`. Container app is healthy, connector/proxy were not recreated, persistent volumes and credential files were retained. The previously deployed app image `nail-app:8bd2efd` remains available. Compose rollback copy: `/home/ubuntu/nail-deploy/compose.before-login-style.yaml`. This validation is an author self-review, not an independent review.
