# Agent Command Center — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Track checkbox steps. This document is planning only; implementation requires a subsequent user instruction.

**Goal:** Membuat dashboard Nail lebih ramai dan menarik melalui tiga karakter agent, ringkasan operasional yang berguna, dan animasi ringan tanpa mengarang aktivitas agent.

**Architecture:** Keep the existing authenticated homepage, `/api/overview` request, validation, and loading/error/retry behavior. Add two presentation-only components fed by the existing overview payload, then a dashboard-scoped stylesheet using CSS-only motion; do not add services, dependencies, polling, or database changes.

**Tech Stack:** Next.js 16.4.2 App Router, React 19.3.0, TypeScript strict, Tailwind CSS 4 plus existing plain CSS, Bun 1.4.3, Vitest 3.2.4.

**Spec:** The user's request is “ubah dashbaord nya lebih menarik lagi, lebih ramai, seperti ada agent agent, dan ada animasi animasi nya”; the concrete design decisions below are proposed defaults, not previously approved visual choices.

## Current context / assumptions

- Repository root: `/home/ubuntu/Project/nail`. Run all commands from the root.
- `app/page.tsx` renders `WorkspaceFrame` and `DashboardOverview`; `app/workspace-frame.tsx` enforces owner authentication. Leave both untouched.
- `app/dashboard-overview.tsx` is a client component. Its exported `DashboardSummary({ overview })` renders the mascot hero, four statistics, and a next-step panel. Its default export handles fetch/error/retry.
- Existing theme is friendly editorial: forest green `#092f2c`, lime `#c6ff4a`, lavender `#e9e0ff`, peach `#ffe0cc`, mint `#b9f3d5`; outlined cards, offset shadows, Geist. Extend this theme, not a dark sci-fi redesign.
- `app/mascot-illustration.tsx` already provides a small SVG robot. Reuse it with scoped CSS custom properties; do not change shared mascot markup or login motion.
- `app/globals.css` imports `app/reference-theme.css`. Existing desktop/tablet/mobile layouts and many rules are shared with other routes. New selectors must start with `.dashboard-content` except uniquely named keyframes.
- `lib/server/dashboard/read-api.ts` exposes aggregate counts only through overview. `activeRunsCount` includes both `running` and `awaiting_review`; do not describe this count as agents currently executing code.
- README explicitly says autonomous PM/engineer/QA execution is incomplete. Three role illustrations must be labeled as illustrations, never as connected/online agents. `agentsCount` is the only actual agent total used here.
- Existing UI tests render static markup with ReactDOM Server. No browser-testing dependency or Vitest config was found. Static tests cannot establish rendered geometry or animation behavior; browser checks below are mandatory.
- Existing working-tree changes at planning time: modified `AGENTS.md`, untracked `.hermes/`, and an untracked image. Do not delete, stage, or commit unrelated files. Do not use the unrequested image asset.
- During planning no tests/builds were run and no application files were changed. Expected test outcomes below are acceptance criteria, not claimed results.

## Proposed visual design

Read top to bottom:

1. Existing heading and hero remain; change the misleading “Data langsung” label to “Ringkasan tersimpan” since there is no live subscription.
2. Keep the four real-number statistic cards.
3. Add an **Agent studio** panel containing three illustrated workstation cards: **PM**, **Engineer**, **QA**, with planning/code/review role descriptions. Each uses the existing friendly robot, a colored circular backdrop, and a numbered “station” label. No random names, statuses, fake terminal output, fake timestamps, fabricated throughput, progress bars, or online dots.
4. Add an **Antrean & keputusan** panel alongside the studio: factual queued-run and pending-approval totals, short real-data-dependent copy, and links to existing routes.
5. Keep the existing next-step/empty panel below these additions, including its tested text.

Desktop: studio/operations split approximately 2:1; studio has three cards. At ≤1100px, stack the two panels, retaining three studio cards. At ≤600px, stack studio cards individually. Gaps 14–18px, corners 20px, borders 2px, restrained 4px offset shadows; no arbitrary emoji or additional fonts.

Motion: cards enter once over 420ms with 70ms stagger; robots gently bob 5px over two 2-second cycles, then stop. Hover/focus raises a card by 3px in 160ms. No infinite decorative motion, sound, mouse tracking, canvas, particle background, layout-property animation, or fake data ticker. `prefers-reduced-motion: reduce` disables every new animation and transform transition.

## Global constraints

- Preserve authentication, route contracts, real counts, error messages, retry, and loading behavior.
- All new user-facing copy is Indonesian except existing product/role terms.
- No dependency changes or edits to `bun.lock`, Next configuration, APIs, database, worker, login, shell, or providers.
- Consult `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` before implementation. These child components are imported into the existing client boundary; they must not import server modules or secrets.
- No running status inferred from a role illustration or aggregate count.
- Commit only explicit files after the task's tests pass. If baseline checks already fail, record exact failures separately; do not claim a green baseline.

## Review focus

1. Empty database: three illustrations must not imply three stored agents; covered by Task 1 zero-count test.
2. Nonzero/large counts: no replacement with demo values and no clipping; covered by Task 2 count tests and browser large-value check.
3. Reduced motion: no new movement, including hover transforms; covered by Task 3 CSS contract test and browser emulation.
4. Mobile and keyboard users: cards stack, links remain visible, no horizontal overflow; covered by Task 3 browser checklist.
5. Fetch errors/authentication: new panels never replace existing error UI or bypass login; covered by final browser/network checks.

## File map

- Create `app/dashboard-agent-studio.tsx`: illustrated roles and truthful stored-agent total.
- Create `app/dashboard-operations.tsx`: overview-derived queued/approval navigation.
- Create `app/dashboard-command-center.css`: responsive layout, local colors, finite motion.
- Modify `app/dashboard-overview.tsx`: imports, one added panel group, truthful heading label.
- Modify `app/globals.css`: import the new stylesheet after the existing CSS imports.
- Create `tests/ui/dashboard-agent-studio.test.tsx`, `tests/ui/dashboard-operations.test.tsx`, `tests/ui/dashboard-command-center.test.tsx`.

## Execution preflight (read-only, ~2–5 minutes)

- [ ] Read `AGENTS.md`, `README.md`, the bundled Next guide above, and the files in the current-context section.
- [ ] Run `git status --short; bun --version; node --version`. Expect the declared Bun toolchain and Node ≥20.9; do not silently install/update tooling if unavailable.
- [ ] Run `bun run test -- tests/ui/dashboard-components.test.tsx tests/ui/reference-theme.test.tsx`. Expect exit 0. Record baseline failures before starting.

## Task 1 — Build the illustrated agent studio

**Files:** Create `app/dashboard-agent-studio.tsx` and `tests/ui/dashboard-agent-studio.test.tsx`.
**Interface:** default export `DashboardAgentStudio({ agentsCount }: { agentsCount: number })`; callers supply validated overview counts.

Each checkbox is one focused step, approximately 2–5 minutes; the full task includes a red/green cycle and commit.

- [ ] Write this complete failing test in `tests/ui/dashboard-agent-studio.test.tsx`:

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardAgentStudio from "../../app/dashboard-agent-studio";

describe("dashboard agent studio", () => {
  it.each([0, 2, 1234])("separates illustrated roles from %s saved agents", (agentsCount) => {
    const html = renderToStaticMarkup(createElement(DashboardAgentStudio, { agentsCount }));
    expect(html).toContain("Agent studio");
    expect(html).toContain(`${new Intl.NumberFormat("id-ID").format(agentsCount)} agent tersimpan`);
    expect(html).toContain("Ilustrasi peran, bukan status agent aktif.");
    expect(html.match(/data-agent-role=/g)).toHaveLength(3);
    for (const role of ["PM", "Engineer", "QA"]) expect(html).toContain(`>${role}</h4>`);
    expect(html).toContain('href="/agents"');
    expect(html).not.toMatch(/online|sedang bekerja|live feed/i);
    if (agentsCount === 0) expect(html).toContain("Belum ada agent tersimpan.");
  });
});
```

- [ ] Run `bun run test -- tests/ui/dashboard-agent-studio.test.tsx`. Expected RED: cannot resolve the new component; unrelated errors are not the intended failure.
- [ ] Create `app/dashboard-agent-studio.tsx` with this complete code:

```tsx
import Link from "next/link";
import MascotIllustration from "./mascot-illustration";

const roles = [
  { id: "pm", name: "PM", station: "01 / RENCANA", copy: "Memecah ide menjadi langkah yang jelas." },
  { id: "engineer", name: "Engineer", station: "02 / IMPLEMENTASI", copy: "Mengerjakan perubahan sesuai rencana." },
  { id: "qa", name: "QA", station: "03 / TINJAUAN", copy: "Memeriksa hasil sebelum diterima." },
] as const;

export default function DashboardAgentStudio({ agentsCount }: { agentsCount: number }) {
  return (
    <section className="agent-studio" aria-labelledby="agent-studio-title">
      <div className="command-panel-heading">
        <div>
          <p className="eyebrow">KENALI PERANNYA</p>
          <h3 id="agent-studio-title">Agent studio</h3>
        </div>
        <span className="agent-studio-count">{new Intl.NumberFormat("id-ID").format(agentsCount)} agent tersimpan</span>
      </div>
      <p className="command-caption">Ilustrasi peran, bukan status agent aktif.</p>
      <div className="agent-studio-grid">
        {roles.map((role) => (
          <article key={role.id} className="agent-role-card" data-agent-role={role.id}>
            <span className="agent-station">{role.station}</span>
            <div className="agent-avatar" aria-hidden="true"><MascotIllustration /></div>
            <h4>{role.name}</h4>
            <p>{role.copy}</p>
          </article>
        ))}
      </div>
      <div className="agent-studio-footer">
        <p>{agentsCount === 0 ? "Belum ada agent tersimpan." : "Lihat daftar agent untuk detail konfigurasi."}</p>
        <Link className="command-link" href="/agents">Lihat agents <span aria-hidden="true">↗</span></Link>
      </div>
    </section>
  );
}
```

- [ ] Run `bun run test -- tests/ui/dashboard-agent-studio.test.tsx`. Expected GREEN, exit 0. No styling assertion yet.
- [ ] Commit: `git add app/dashboard-agent-studio.tsx tests/ui/dashboard-agent-studio.test.tsx && git commit -m "feat: add truthful illustrated agent studio"`.

## Task 2 — Add the operational companion panel

**Files:** Create `app/dashboard-operations.tsx` and `tests/ui/dashboard-operations.test.tsx`.
**Interface:** default export `DashboardOperations({ overview }: { overview: OverviewPayload })`. Import `OverviewPayload` with `import type`; never import server data code.

- [ ] Write `tests/ui/dashboard-operations.test.tsx`:

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardOperations from "../../app/dashboard-operations";

describe("dashboard operations", () => {
  it.each([0, 4, 1234])("shows actual stored queue and approval totals: %s", (count) => {
    const html = renderToStaticMarkup(createElement(DashboardOperations, {
      overview: { projectsCount: 0, agentsCount: 0, activeRunsCount: 0, queuedRunsCount: count, pendingApprovalsCount: count },
    }));
    expect(html).toContain("Antrean &amp; keputusan");
    expect(html).toContain(`>${new Intl.NumberFormat("id-ID").format(count)}</strong>`);
    expect(html).toContain('href="/tasks"');
    expect(html).toContain('href="/approvals"');
    expect(html).toContain(count === 0 ? "Tidak ada persetujuan tertunda." : "Ada keputusan yang perlu ditinjau.");
    expect(html).toContain(count === 0 ? "Tidak ada run dalam antrean." : "Run tersimpan menunggu giliran.");
    expect(html).not.toMatch(/menit lalu|online|persen|%/i);
  });
});
```

- [ ] Run `bun run test -- tests/ui/dashboard-operations.test.tsx`. Expected RED: missing component import.
- [ ] Create `app/dashboard-operations.tsx`:

```tsx
import Link from "next/link";
import type { OverviewPayload } from "./dashboard-overview";

export default function DashboardOperations({ overview }: { overview: OverviewPayload }) {
  const format = new Intl.NumberFormat("id-ID");
  return (
    <section className="dashboard-operations" aria-labelledby="dashboard-operations-title">
      <p className="eyebrow">PERLU DIPERHATIKAN</p>
      <h3 id="dashboard-operations-title">Antrean &amp; keputusan</h3>
      <p className="command-caption">Ringkasan tersimpan, bukan feed real-time.</p>
      <div className="operation-item">
        <span>Run dalam antrean</span>
        <strong>{format.format(overview.queuedRunsCount)}</strong>
        <p>{overview.queuedRunsCount === 0 ? "Tidak ada run dalam antrean." : "Run tersimpan menunggu giliran."}</p>
        <Link className="command-link" href="/tasks">Buka tasks <span aria-hidden="true">↗</span></Link>
      </div>
      <div className="operation-item">
        <span>Menunggu persetujuan</span>
        <strong>{format.format(overview.pendingApprovalsCount)}</strong>
        <p>{overview.pendingApprovalsCount === 0 ? "Tidak ada persetujuan tertunda." : "Ada keputusan yang perlu ditinjau."}</p>
        <Link className="command-link" href="/approvals">Tinjau approvals <span aria-hidden="true">↗</span></Link>
      </div>
    </section>
  );
}
```

- [ ] Run `bun run test -- tests/ui/dashboard-operations.test.tsx`. Expected GREEN, exit 0.
- [ ] Commit: `git add app/dashboard-operations.tsx tests/ui/dashboard-operations.test.tsx && git commit -m "feat: add dashboard queue and decision panel"`.

## Task 3 — Integrate, style, and animate

**Files:** Modify `app/dashboard-overview.tsx`, `app/globals.css`; create `app/dashboard-command-center.css`, `tests/ui/dashboard-command-center.test.tsx`.
**Interface:** Preserve the existing `DashboardSummary` export and `OverviewPayload` fields unchanged. New components render only within the successful overview state.

- [ ] Write `tests/ui/dashboard-command-center.test.tsx`:

```tsx
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardSummary } from "../../app/dashboard-overview";

describe("dashboard command center integration", () => {
  it("adds both panels without losing the existing empty state", () => {
    const html = renderToStaticMarkup(createElement(DashboardSummary, {
      overview: { projectsCount: 0, agentsCount: 0, activeRunsCount: 0, queuedRunsCount: 0, pendingApprovalsCount: 0 },
    }));
    expect(html).toContain("Agent studio");
    expect(html).toContain("Antrean &amp; keputusan");
    expect(html).toContain("Belum ada project tersimpan");
    expect(html).toContain("data-dashboard-mascot");
    expect(html).toContain('class="dashboard-command-grid"');
  });

  it("loads a responsive finite-motion stylesheet with a reduced-motion override", () => {
    const globals = readFileSync("app/globals.css", "utf8");
    const css = readFileSync("app/dashboard-command-center.css", "utf8");
    expect(globals).toContain('@import "./dashboard-command-center.css";');
    expect(css).toContain("@media (max-width: 1100px)");
    expect(css).toContain("@media (max-width: 600px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none;");
    expect(css).toContain("transition: none;");
    expect(css).toContain("transform: none;");
    expect(css).not.toContain("infinite");
  });
});
```

- [ ] Run `bun run test -- tests/ui/dashboard-command-center.test.tsx`. Expected RED: missing panels/stylesheet.
- [ ] In `app/dashboard-overview.tsx`, add these imports after `MascotIllustration`:

```tsx
import DashboardAgentStudio from "./dashboard-agent-studio";
import DashboardOperations from "./dashboard-operations";
```

Insert this exact block immediately before `<section className="dashboard-empty-panel">`:

```tsx
<div className="dashboard-command-grid">
  <DashboardAgentStudio agentsCount={overview.agentsCount} />
  <DashboardOperations overview={overview} />
</div>
```

Replace the entire heading indicator span with:

```tsx
<span className="dashboard-snapshot-label">Ringkasan tersimpan</span>
```

Leave every other line of the fetch, validation, error, retry, and existing summary content unchanged.

- [ ] Create `app/dashboard-command-center.css` with the complete stylesheet below. In `app/globals.css`, add `@import "./dashboard-command-center.css";` immediately after `@import "./reference-theme.css";` (before `:root`). Unique selectors avoid the shared-theme cascade rather than fighting it with global overrides.

```css
.dashboard-content .dashboard-snapshot-label {
  color: var(--muted);
  font-size: 12px;
}
.dashboard-content .dashboard-command-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
  gap: 18px;
  margin-top: 24px;
}
.dashboard-content .agent-studio,
.dashboard-content .dashboard-operations {
  min-width: 0;
  padding: 22px;
  border: 2px solid var(--line);
  border-radius: 20px;
  box-shadow: 4px 4px 0 var(--line);
  background: var(--surface);
}
.dashboard-content .agent-studio {
  background-color: #f8fbf8;
  background-image: radial-gradient(#123e361a 1px, transparent 1px);
  background-size: 14px 14px;
}
.dashboard-content .dashboard-operations { background: #f0eaff; }
.dashboard-content .command-panel-heading,
.dashboard-content .agent-studio-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.dashboard-content .command-panel-heading h3,
.dashboard-content .dashboard-operations h3 { margin: 0; font-size: 21px; }
.dashboard-content .agent-studio-count {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 6px 10px;
  background: var(--lime);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.dashboard-content .command-caption,
.dashboard-content .agent-studio-footer p {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}
.dashboard-content .agent-studio-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin: 20px 0 12px;
}
.dashboard-content .agent-role-card {
  min-width: 0;
  padding: 14px;
  border: 2px solid var(--line);
  border-radius: 16px;
  background: #e8f6dc;
  transition: transform 160ms ease;
  animation: nail-agent-enter 420ms ease-out backwards;
}
.dashboard-content .agent-role-card[data-agent-role="engineer"] {
  --lime: #e9e0ff;
  background: #f1ebff;
  animation-delay: 70ms;
}
.dashboard-content .agent-role-card[data-agent-role="qa"] {
  --lime: #ffe0cc;
  background: #fff0e4;
  animation-delay: 140ms;
}
.dashboard-content .agent-role-card:hover,
.dashboard-content .operation-item:focus-within { transform: translateY(-3px); }
.dashboard-content .agent-station {
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.07em;
  overflow-wrap: anywhere;
}
.dashboard-content .agent-avatar {
  display: grid;
  place-items: center;
  width: min(100%, 126px);
  aspect-ratio: 1;
  margin: 14px auto;
  border-radius: 50%;
  background: rgb(255 255 255 / 65%);
}
.dashboard-content .agent-avatar svg {
  display: block;
  width: 100%;
  height: auto;
  animation: nail-agent-bob 2s ease-in-out 2;
}
.dashboard-content [data-agent-role="engineer"] .agent-avatar svg { animation-delay: 70ms; }
.dashboard-content [data-agent-role="qa"] .agent-avatar svg { animation-delay: 140ms; }
.dashboard-content .agent-role-card h4 { margin: 0; font-size: 17px; }
.dashboard-content .agent-role-card p,
.dashboard-content .operation-item p {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.dashboard-content .command-link {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 4px 0;
  font-size: 12px;
  font-weight: 750;
  color: var(--foreground);
  text-underline-offset: 4px;
}
.dashboard-content .operation-item {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgb(255 255 255 / 75%);
  transition: transform 160ms ease;
}
.dashboard-content .operation-item > span { display: block; font-size: 12px; }
.dashboard-content .operation-item strong {
  display: block;
  margin-top: 8px;
  font-size: 28px;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
@keyframes nail-agent-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes nail-agent-bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
}
@media (max-width: 1100px) {
  .dashboard-content .dashboard-command-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 600px) {
  .dashboard-content .agent-studio-grid { grid-template-columns: minmax(0, 1fr); }
  .dashboard-content .agent-studio,
  .dashboard-content .dashboard-operations { padding: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .dashboard-content .agent-role-card,
  .dashboard-content .agent-avatar svg,
  .dashboard-content .operation-item {
    animation: none;
    transition: none;
    transform: none;
  }
}
```

- [ ] Run `bun run test -- tests/ui/dashboard-agent-studio.test.tsx tests/ui/dashboard-operations.test.tsx tests/ui/dashboard-command-center.test.tsx tests/ui/dashboard-components.test.tsx tests/ui/reference-theme.test.tsx`. Expected GREEN, exit 0, including unchanged baseline assertions.
- [ ] Commit: `git add app/dashboard-overview.tsx app/globals.css app/dashboard-command-center.css tests/ui/dashboard-command-center.test.tsx && git commit -m "feat: compose animated dashboard command center"`.

## Final tests / validation

Each checkbox is a separate verification step. Do not describe code changes as visually verified until the browser steps have actually been performed.

- [ ] Run `bun run lint`. Expected exit 0, no new lint errors.
- [ ] Run `bun run test`. Expected exit 0; live sandbox tests may be skipped by existing opt-in behavior. Never enable live provider/sandbox calls for this visual task.
- [ ] Run `bun run build`. Expected exit 0 and successful Next production build/type checking. If environment or font networking prevents it, report the exact blocker rather than declaring success.
- [ ] Run `bun run dev`, use the URL printed by Next, and authenticate using the existing owner setup from README. Never print secrets or bypass authentication. If credentials/configuration are unavailable, ask the owner to perform the authenticated browser pass.
- [ ] At viewport widths 1440, 1024, 768, and 390px, check `/`: hero → metrics → studio/operations → next-step panel; three role cards; no overlap, clipping, or horizontal scrollbar. Browser console expression `document.documentElement.scrollWidth <= window.innerWidth` must return `true`. Save screenshots with browser tooling if available; otherwise record manual observations, not invented artifacts.
- [ ] Reload `/` with normal motion: entry finishes promptly and bobbing stops within five seconds. Emulate reduced motion in browser rendering tools, reload, and inspect an `.agent-avatar svg`: `getComputedStyle(document.querySelector('.agent-avatar svg')).animationName` returns `"none"`. Repeat hover/focus: no translation with reduced motion enabled.
- [ ] Tab through links. Visible focus rings, ≥44px link height, real destinations `/agents`, `/tasks`, `/approvals`; no decorative card becomes a misleading button. Check login and providers visually remain unchanged.
- [ ] Use browser network response overrides for `/api/overview` only (do not insert fake database rows): verify a zero fixture and a fixture with every count set to `1234567`. Expected visible totals use Indonesian formatting, card text wraps, all labels remain truthful, and the page never claims illustrative agents are active. Remove overrides after testing.
- [ ] Throttle network and reload: original loading UI is visible, no fabricated counts. Override `/api/overview` with HTTP 503 JSON `{"error":"Database is not configured"}`: original setup hint and Coba lagi appear; new panels do not appear. Remove override and click Coba lagi: overview returns. In an unauthenticated browser session, `/` still requires login.
- [ ] Run `git diff --check; git status --short`. Expected no whitespace errors; only deliberately scoped commits and pre-existing unrelated changes. Report checks actually run, screenshots/observations, and remaining blockers.

## Risks, tradeoffs, and open questions

- **Visual direction assumption:** This proposes friendly illustrated agent stations, not a game-like moving office or 3D world. The user can request the latter before execution; that would need a different scope and asset plan.
- **Illustrations versus actual roster:** This delivers visible agent characters without pretending incomplete orchestration is live. Actual per-agent run telemetry, agent names, recent event history, and WebSocket updates are deliberately out of scope. If the user specifically wants a real roster, extend the design with `/api/agents` validation/loading/error behavior rather than attaching fake status to these illustrations.
- **Density:** Three characters plus an operations panel make the dashboard busier but increase mobile height. Keep the hero and navigation stable; do not shrink text or use horizontal carousels to compensate.
- **Motion:** Finite bobbing provides life without permanent distraction or requiring a new pause-control state. Continuous animation would require a pause mechanism and further accessibility tests.
- **Verification limits:** Static markup and CSS-source tests protect contracts but not appearance. Authenticated browser checks are a release gate, not optional proof supplied by Vitest.
- **Existing count semantics:** The existing active-run statistic also includes awaiting-review runs; this plan avoids introducing additional execution claims but does not redefine the API.
- No blocking questions are required for this bounded presentation-only proposal. Review the aesthetic assumptions before authorizing implementation.
