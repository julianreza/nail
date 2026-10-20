# Reference Theme Implementation Plan

> Execute inline with superpowers:executing-plans and test-driven-development. The owner approved applying the supplied dashboard reference across Nail, including login.

**Goal:** Apply the reference's forest-green, acid-lime and off-white visual language without inventing business data or changing authentication/orchestration behavior.

**Architecture:** Preserve existing routes, domain/API contracts and persisted counts. Reuse existing global tokens and route-local login CSS; use namespaced classes (not CSS Modules with this project's custom loader). Add a small shared inline SVG icon component, truthful overview hero with real navigation, white statistic cards and an accessible current-page label.

**Constraints:** No new dependencies, no fake charts/growth/activity, no credential/session/database changes, no commit/merge without owner request. Isolated branch feature/reference-theme from 646b500. Keep unrelated main changes untouched. Deploy only app after preview browser verification; retain rollback image/config and persistent volumes.

## Task 1 — Shared shell and reference theme
- Add failing SSR tests for visible current-page context and labeled navigation with one active item; test real project/agent totals and project link in overview hero, including zero counts.
- Run focused tests, expect assertion failures for missing current-page context/hero.
- Add shared decorative SVG icons; update shell and overview markup, keeping APIs and state handling unchanged.
- Apply global forest #0c2a1f, lime #cdfc68, off-white #f6f8f4, white cards; pastel icons, slim dark topbar, highlighted headings, dotted hero and limited rotated labels. Maintain loading/error/empty states and responsive navigation.
- Align login, provider forms, project/run cards and settings through shared tokens/rules; keep semantic labels, keyboard focus, touch targets and reduced motion.
- Run full Vitest, ESLint and diff checks; expect all pass. Build explicit Docker app target, expect default Turbopack/TypeScript success.

## Task 2 — Browser verification and rollout
- Start disposable loopback preview, not production. Check login, shell and every existing top-level page at 1440px, 768px, 390px and 320px; use fixtures only for clearly labeled preview test data.
- Assert computed reference colors, usable current-page context, no document horizontal overflow, working links and no JS errors. Visually inspect real screenshots against the supplied image.
- Exercise loading/API error/retry and empty-state behavior; use read-only real API counts on live rollout, not fabricated activity.
- Self-review changes (no subagent tool). Only after preview passes, replace app image through existing private deployment Compose; do not recreate volumes or connector/proxy.
- Verify public HTTPS, actual browser owner login/logout, top-level navigation, live counts and container health. Record evidence and source branch in deployment notes. Leave code uncommitted for owner integration.

## Review focus
Long labels and URLs; 320px provider forms; cache-components retained hidden pages; plaintext passwords never captured in screenshots/logs; focus contrast on dark topbar; no decorative chart that could imply verified agent execution.
