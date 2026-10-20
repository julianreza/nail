# Reference theme validation

Validation source: branch `feature/reference-theme`, based on `646b500`. The owner approved adapting the supplied dashboard image across Nail, including login and the main workspace pages. This records the initial theme verification, before the later build-only color and login refinements. The owner subsequently authorized committing and merging the combined changes to `main` without rerunning tests.

## Delivered

- Reference-inspired forest green `#0c2a1f`, lime `#cdfc68`, off-white `#f6f8f4`, pale sidebar and white statistic surfaces.
- Compact forest topbar with current-page context and owner indicator; real existing navigation routes, pastel decorative SVG icons and clear active navigation.
- Dotted lime overview hero, limited rotated sticker and brand emblem, highlighted page title, actual project/agent totals and a real Projects link. No invented revenue, growth, progress chart or execution evidence.
- Shared cards/buttons/provider forms and project/run surfaces inherit the reference tokens; login uses a matching forest header, lime submit and dotted background.
- Retained fetch/state/error/retry/authentication contracts. No database migration, credential/session changes, new dependency or vendor inference.

## Verification

- Three new SSR cases failed for missing page context and hero before implementation, then passed.
- Full Vitest: 37 files / 147 tests passed.
- ESLint and `git diff --check`: passed.
- Explicit Docker app build: default Next.js Turbopack build and TypeScript passed. Final tag `nail-app:reference-theme-3`.
- Disposable Docker runtime smoke passed with the final image: missing secrets, auth/origin guards, private connector transport, non-root/capability-free process and SQLite persistence.
- Browser preview checked all seven main routes at widths 1440, 768, 390 and 320: rendered reference palette, current page, one active top-level navigation item, no horizontal overflow and overview matching actual preview API counts.
- Preview-only API failure/retry and zero counts passed. Clearly labeled preview fixtures with very long project names and repository URLs passed at 768/320px; no fixtures were written to the live database.
- Desktop/mobile dashboard, login and Providers screenshots were visually reviewed against the supplied image.
- After rollout, actual owner browser login and logout through public HTTPS passed. All seven live routes passed at those same widths with no JS exceptions, no horizontal overflow and overview counts matching the persisted API. No credentials/cookies were printed or captured in screenshots.

## Findings resolved

- At 768px, the provider setup's fixed minimum grid tracks exceeded the available content width beside the sidebar. A browser test reproduced document width 803px for a 768px viewport. Provider setup now switches to one column before that boundary; final browser tests pass.
- Extremely long unbroken project names/URLs expanded implicit grid tracks. The existing record list now uses `minmax(0, 1fr)` and `min-width: 0`; the long-label browser regression passed after the fix.

## Review and decisions

Final review: self-review (no subagent tool available). Checked source diff, new icon/CSS files, loader compatibility, route/accessibility labels, truthful persisted totals and loading/error/empty states. No unresolved critical or important finding within this visual-change scope; this is not an independent review.

Ruling: retain existing top-level routes and responsive wrapping rather than introducing a new collapsible sidebar, search box, report button or financial chart. Those controls in the reference have no equivalent implemented Nail feature; copying them would create dead controls or invented data. Cost if the owner intended those features: separate functionality work is required.

Ruling: keep source uncommitted and unmerged because this request authorizes styling and deployment, not automatic integration. Cost: the deployment is reproducible from this retained worktree but needs an explicit commit/merge step for Git history.

## Rollout

Only the app container was replaced. Current app image is `nail-app:reference-theme-3`, healthy; connector/proxy containers, persistent volumes and secrets were retained. Rollback: prior image `nail-app:login-style-2` and `/home/ubuntu/nail-deploy/compose.before-reference-theme.yaml`. Deployment URL remains `https://43.173.12.116:8443`. Existing self-signed certificate warning is unchanged.
