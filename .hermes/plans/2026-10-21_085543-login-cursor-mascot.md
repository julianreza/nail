# Nail login: original cursor-following bot

> Planning only. No implementation, dependency installation, Git mutation, deployment or asset upload was performed while writing this plan.
>
> For implementation, use `superpowers:executing-plans` (native/inline) and `superpowers:test-driven-development`. Owner approval is required before implementation; deployment is a separate, explicit gate below.

## Goal

Replace the large decorative N in the login showcase with an original Nail robot whose eyes and head subtly follow the mouse, using SVG/CSS rather than Rive.

## Current context / assumptions

- Repository: `/home/ubuntu/Project/nail`; inspected `main` is `9b5e79b`.
- Stack: Next.js 16.4.2, React 19.3.0, strict TypeScript, Tailwind 4, Vitest 3.2.4. `bun.lock` and Bun 1.4.3 are declared; no Bun executable is on the inspected host PATH. Docker has been used for production builds.
- `app/login/page.tsx` is a Server Component. It renders a two-panel login with decorative N at `.login-art-core`; the small header N is `.workspace-brand-mark`. **Replace only the large N; retain the small header logo.**
- `app/login/login-form.tsx` is a separate Client Component. Its password submission, error handling, redirects, autocomplete and labels must not change.
- `app/login/login.css` contains existing namespaced global CSS. At widths <=820px it hides the complete `.login-showcase`; this must be adjusted so the mascot is visible in a compact strip on phones.
- Current token values: foreground `#092f2c`, emerald `#164b3d`, lime `#c6ff4a`, background `#eef4f1`, mint `#b9f3d5`. Use the existing CSS variables rather than another palette.
- The Rive experiment was rejected and rolled back. `.worktrees/rive-login` is clean at its base and is not the place for this new work. Do not restore Rive dependencies or assets. The uploaded `.riv` remains untouched.
- Main has unrelated changes: modified `AGENTS.md`, untracked `.hermes/` and an image. Do not stage, discard or copy those into a feature commit.
- Live deployment: `/home/ubuntu/nail-deploy/compose.yaml`, app `nail-app:9b5e79b`, URL `https://43.173.12.116:8443/login`, self-signed certificate. Database/secrets must be preserved; no Docker socket is mounted into the app.
- No precise Grok animation reference was provided. **Design assumption:** imitate the interaction category (eyes/head tracking), not Grok's artwork, branding, exact geometry or identity. This is an original Nail mascot.
- Scope is deliberately small: eyes follow cursor, head leans slightly, CSS blink. No chat, audio, AI model, password-reading reaction, draggable mascot, auto expression cycling, analytics or UI settings.

## Architecture / proposed approach

Create a small Client Component for the inline SVG and attach a DOM-only pointer controller in `useEffect`; leave the page and form boundaries intact. Compute a bounded pose in a pure helper, coalesce mouse events into one requested animation frame, and set CSS custom properties instead of React state on every pointer event. On touch/coarse pointers or reduced-motion preference, render the same centered static face with no animation loop; reset on viewport exit, blur or tab hiding, and detach everything on unmount.

### Visual contract (implement this, not an improvised redesign)

- SVG viewBox `0 0 240 200`; lime rounded-square robot head, dark emerald visor, two white eyes with dark pupils, small mint mouth and antenna tip.
- Desktop mascot wrapper: 220x190 CSS pixels, centered in the former large N position; no background square, embedded mini-buttons or copied character.
- Pupils: max horizontal +/-6 SVG units and vertical +/-4. Head: max translate +/-3px x, +/-2px y and rotate +/-4deg. Neutral is all zero.
- Keep existing orbit background; remove the three floating decorative chips from this login art so they cannot overlap or look clickable. Keep the rest of the desktop copy and form.
- Phone/tablet <=820px: show only a compact 160px-high showcase strip and mascot; hide showcase marketing copy/footer/orbits. Form follows directly. Do not hide the mascot or alter login input/submit semantics.
- Movement uses a 120ms ease-out transition. Blink is a brief CSS scaleY animation every 6 seconds, not an interval in JavaScript. Disable blink and movement for reduced motion and coarse/no-hover pointers.
- No continuous idle rotation, bobbing or breathing animation in v1. The key acceptance condition is clearly measurable eye/head movement, not an `autoplay` flag.

## Files

Create:
- `app/login/mascot-pose.ts` — pure bounded pose.
- `app/login/mascot-tracking.ts` — DOM event lifecycle and frame coalescing.
- `app/login/login-mascot.tsx` — decorative SVG Client Component.
- `app/login/login-mascot.css` — namespaced mascot styles/responsive strip.
- `tests/ui/mascot-pose.test.ts`.
- `tests/ui/mascot-tracking.test.ts`.
- `tests/ui/login-mascot.test.tsx`.
- `scripts/login-mascot-browser-check.cjs` — explicit opt-in browser validation, no credentials.

Modify:
- `app/login/page.tsx` — replace large N with component, remove decorative chips.
- `app/login/login.css` — remove obsolete `.login-art-core`/`.login-art-chip*` rules only. Keep existing form and shell CSS.

Do not modify: authentication/domain/worker APIs, root layout, `package.json`, lockfile, original `.riv`, persisted application data, or dashboard styles.

## Commands / setup

These are **future implementation commands**, not commands to execute in plan mode.

```sh
cd /home/ubuntu/Project/nail
git status --short --branch
git check-ignore .worktrees
git worktree add .worktrees/cursor-mascot -b feature/cursor-mascot
ln -s /home/ubuntu/Project/nail/node_modules .worktrees/cursor-mascot/node_modules
```

Expected: `.worktrees` is ignored; new worktree starts at current main. If main moved since `9b5e79b`, inspect the login files before applying the exact replacements. Do not reset other branches or reuse the Rive worktree. If the requested branch/path already exists, inspect and resume it rather than overwriting it.

For subsequent commands, work from `/home/ubuntu/Project/nail/.worktrees/cursor-mascot`.

Baseline:

```sh
node /home/ubuntu/Project/nail/node_modules/vitest/vitest.mjs run
```

Expected: existing tests pass; opt-in sandbox test may be skipped. Record actual totals rather than copying historical numbers. Stop and investigate if baseline is red.

Commit identity for these authorized implementation commits: `julianreza <rhezandroid@gmail.com>` (provided earlier by owner). Use per-command `git -c`, not global Git configuration changes. Do not merge/push without a separate request.

## Task 1 — Pure bounded pose (2–5 minutes)

### RED: create `tests/ui/mascot-pose.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { getMascotPose, NEUTRAL_POSE } from "../../app/login/mascot-pose";

const bounds = { left: 100, top: 50, width: 200, height: 100 };

describe("mascot pose", () => {
  it("looks forward at the center", () => {
    expect(getMascotPose(200, 100, bounds)).toEqual(NEUTRAL_POSE);
  });
  it("clamps movement even far outside the artwork", () => {
    expect(getMascotPose(10000, 10000, bounds)).toEqual({ eyeX: 6, eyeY: 4, headX: 3, headY: 2, rotate: 4 });
    expect(getMascotPose(-10000, -10000, bounds)).toEqual({ eyeX: -6, eyeY: -4, headX: -3, headY: -2, rotate: -4 });
  });
  it("produces proportional movement inside the bounds", () => {
    expect(getMascotPose(250, 125, bounds)).toEqual({ eyeX: 3, eyeY: 2, headX: 1.5, headY: 1, rotate: 2 });
  });
  it("fails safely for invalid coordinates or empty bounds", () => {
    expect(getMascotPose(NaN, 100, bounds)).toEqual(NEUTRAL_POSE);
    expect(getMascotPose(200, Infinity, bounds)).toEqual(NEUTRAL_POSE);
    expect(getMascotPose(200, 100, { ...bounds, width: 0 })).toEqual(NEUTRAL_POSE);
    expect(getMascotPose(200, 100, { ...bounds, left: NaN })).toEqual(NEUTRAL_POSE);
  });
});
```

Run:

```sh
node /home/ubuntu/Project/nail/node_modules/vitest/vitest.mjs run tests/ui/mascot-pose.test.ts
```

Expected RED: missing module. Then create `app/login/mascot-pose.ts`:

```ts
export interface MascotPose {
  eyeX: number;
  eyeY: number;
  headX: number;
  headY: number;
  rotate: number;
}
export const NEUTRAL_POSE: MascotPose = { eyeX: 0, eyeY: 0, headX: 0, headY: 0, rotate: 0 };
export function getMascotPose(
  x: number,
  y: number,
  bounds: { left: number; top: number; width: number; height: number },
): MascotPose {
  if (![x, y, bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return { ...NEUTRAL_POSE };
  const clamp = (n: number) => Math.max(-1, Math.min(1, n));
  const nx = clamp((x - bounds.left - bounds.width / 2) / (bounds.width / 2));
  const ny = clamp((y - bounds.top - bounds.height / 2) / (bounds.height / 2));
  return { eyeX: nx * 6, eyeY: ny * 4, headX: nx * 3, headY: ny * 2, rotate: nx * 4 };
}
```

Rerun the focused command; expected GREEN: 4 cases pass. Commit only these two files:

```sh
git add app/login/mascot-pose.ts tests/ui/mascot-pose.test.ts
git -c user.name=julianreza -c user.email=rhezandroid@gmail.com commit -m "feat: bound login mascot gaze geometry"
```

## Task 2 — Pointer lifecycle controller (2–5 minutes)

### RED: create `tests/ui/mascot-tracking.test.ts`

Use real `EventTarget` objects and a frame queue at the DOM boundary; no jsdom dependency is needed.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachMascotTracking } from "../../app/login/mascot-tracking";

function harness() {
  const values = new Map<string, string>();
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const fine = Object.assign(new EventTarget(), { matches: true });
  const reduced = Object.assign(new EventTarget(), { matches: false });
  const view = Object.assign(new EventTarget(), {
    matchMedia: (query: string) => query.includes("reduced-motion") ? reduced : fine,
    requestAnimationFrame: (cb: FrameRequestCallback) => { frames.set(++sequence, cb); return sequence; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  });
  const doc = Object.assign(new EventTarget(), { defaultView: view, hidden: false, documentElement: new EventTarget() });
  const element = {
    ownerDocument: doc,
    style: { setProperty: (key: string, value: string) => { values.set(key, value); } },
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
  } as unknown as HTMLElement;
  const move = (x: number, y: number, pointerType = "mouse") => {
    view.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: x, clientY: y, pointerType }));
  };
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((cb) => cb(0)); };
  return { element, values, frames, view, doc, fine, reduced, move, flush };
}

afterEach(() => vi.restoreAllMocks());

describe("mascot tracking", () => {
  it("coalesces events and applies the latest bounded gaze", () => {
    const h = harness(); const cleanup = attachMascotTracking(h.element);
    h.move(100, 50); h.move(10000, 10000);
    expect(h.frames.size).toBe(1);
    h.flush();
    expect(h.values.get("--mascot-eye-x")).toBe("6px");
    expect(h.values.get("--mascot-eye-y")).toBe("4px");
    expect(h.values.get("--mascot-rotate")).toBe("4deg");
    cleanup();
  });
  it("ignores touch, disables reduced motion, and resets on blur", () => {
    const h = harness(); const cleanup = attachMascotTracking(h.element);
    h.move(10000, 10000, "touch"); expect(h.frames.size).toBe(0);
    h.move(10000, 10000); h.flush();
    h.view.dispatchEvent(new Event("blur"));
    expect(h.values.get("--mascot-eye-x")).toBe("0px");
    h.reduced.matches = true; h.reduced.dispatchEvent(new Event("change"));
    h.move(10000, 10000); expect(h.frames.size).toBe(0);
    cleanup();
  });
  it("ignores mouse tracking when the primary pointer is coarse", () => {
    const h = harness(); const cleanup = attachMascotTracking(h.element);
    h.fine.matches = false; h.fine.dispatchEvent(new Event("change"));
    h.move(10000, 10000);
    expect(h.frames.size).toBe(0);
    expect(h.values.get("--mascot-eye-x")).toBe("0px");
    cleanup();
  });
  it("resets on exit/hide and drops pending work and listeners on cleanup", () => {
    const h = harness(); const cleanup = attachMascotTracking(h.element);
    h.move(10000, 10000); h.flush();
    h.doc.documentElement.dispatchEvent(new Event("pointerleave"));
    expect(h.values.get("--mascot-rotate")).toBe("0deg");
    h.doc.hidden = true; h.doc.dispatchEvent(new Event("visibilitychange"));
    h.move(10000, 10000); expect(h.frames.size).toBe(0);
    h.doc.hidden = false; h.move(10000, 10000);
    expect(h.frames.size).toBe(1);
    cleanup(); expect(h.frames.size).toBe(0);
    h.move(0, 0); expect(h.frames.size).toBe(0);
  });
});
```

Run focused test, expect missing module. Implement `app/login/mascot-tracking.ts`:

```ts
import { getMascotPose, NEUTRAL_POSE, type MascotPose } from "./mascot-pose";

export function attachMascotTracking(element: HTMLElement): () => void {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view) return () => undefined;
  const fine = view.matchMedia("(hover: hover) and (pointer: fine)");
  const reduced = view.matchMedia("(prefers-reduced-motion: reduce)");
  let frame: number | undefined;
  let point: { x: number; y: number } | undefined;
  const apply = (pose: MascotPose) => {
    element.style.setProperty("--mascot-eye-x", `${pose.eyeX}px`);
    element.style.setProperty("--mascot-eye-y", `${pose.eyeY}px`);
    element.style.setProperty("--mascot-head-x", `${pose.headX}px`);
    element.style.setProperty("--mascot-head-y", `${pose.headY}px`);
    element.style.setProperty("--mascot-rotate", `${pose.rotate}deg`);
  };
  const enabled = () => fine.matches && !reduced.matches && !doc.hidden;
  const reset = () => {
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
    point = undefined;
    apply(NEUTRAL_POSE);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || !enabled()) return;
    point = { x: event.clientX, y: event.clientY };
    if (frame !== undefined) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      if (!point || !enabled()) return;
      apply(getMascotPose(point.x, point.y, element.getBoundingClientRect()));
    });
  };
  const onGeometryChange = () => reset();
  view.addEventListener("pointermove", onPointerMove, { passive: true });
  view.addEventListener("blur", reset);
  view.addEventListener("resize", onGeometryChange);
  view.addEventListener("scroll", onGeometryChange, { passive: true, capture: true });
  doc.documentElement.addEventListener("pointerleave", reset);
  doc.addEventListener("visibilitychange", reset);
  fine.addEventListener("change", reset);
  reduced.addEventListener("change", reset);
  apply(NEUTRAL_POSE);
  return () => {
    view.removeEventListener("pointermove", onPointerMove);
    view.removeEventListener("blur", reset);
    view.removeEventListener("resize", onGeometryChange);
    view.removeEventListener("scroll", onGeometryChange, true);
    doc.documentElement.removeEventListener("pointerleave", reset);
    doc.removeEventListener("visibilitychange", reset);
    fine.removeEventListener("change", reset);
    reduced.removeEventListener("change", reset);
    reset();
  };
}
```

Run:

```sh
node /home/ubuntu/Project/nail/node_modules/vitest/vitest.mjs run tests/ui/mascot-pose.test.ts tests/ui/mascot-tracking.test.ts
```

Expected: 8 cases pass, including the coarse-pointer policy.

```sh
git add app/login/mascot-tracking.ts tests/ui/mascot-tracking.test.ts
git -c user.name=julianreza -c user.email=rhezandroid@gmail.com commit -m "feat: track mascot cursor with bounded frame lifecycle"
```

## Task 3 — Original SVG component (2–5 minutes)

Write `tests/ui/login-mascot.test.tsx` first:

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginMascot from "../../app/login/login-mascot";

 describe("login mascot", () => {
  it("server-renders decorative art without a network asset or focus target", () => {
    const html = renderToStaticMarkup(createElement(LoginMascot));
    expect(html).toContain("data-login-mascot");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('viewBox="0 0 240 200"');
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain(".riv");
    expect(html).not.toContain("tabindex");
  });
});
```

Run focused test, expect missing component. Create `app/login/login-mascot.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { attachMascotTracking } from "./mascot-tracking";
import "./login-mascot.css";

export default function LoginMascot() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    return attachMascotTracking(root.current);
  }, []);
  return (
    <div className="login-mascot" data-login-mascot aria-hidden="true" ref={root}>
      <svg viewBox="0 0 240 200" fill="none" focusable="false">
        <ellipse cx="120" cy="181" rx="61" ry="9" fill="#092f2c" opacity="0.25" />
        <g className="login-mascot-head">
          <path d="M120 38V25" stroke="#b9f3d5" strokeWidth="5" strokeLinecap="round" />
          <circle cx="120" cy="19" r="7" fill="var(--mint)" stroke="var(--line)" strokeWidth="3" />
          <rect x="46" y="67" width="18" height="47" rx="8" fill="var(--mint)" stroke="var(--line)" strokeWidth="3" />
          <rect x="176" y="67" width="18" height="47" rx="8" fill="var(--mint)" stroke="var(--line)" strokeWidth="3" />
          <rect x="59" y="41" width="128" height="126" rx="37" fill="#092f2c" />
          <rect x="54" y="36" width="128" height="126" rx="37" fill="var(--lime)" stroke="var(--line)" strokeWidth="3" />
          <path d="M72 60c8-10 18-13 32-13" stroke="#f5ffe1" strokeWidth="4" strokeLinecap="round" />
          <rect x="69" y="69" width="98" height="57" rx="25" fill="var(--foreground)" />
          <g className="login-mascot-blink">
            <ellipse cx="96" cy="97" rx="14" ry="17" fill="#fff" />
            <ellipse cx="140" cy="97" rx="14" ry="17" fill="#fff" />
            <g className="login-mascot-pupils">
              <ellipse cx="96" cy="98" rx="5" ry="7" fill="var(--foreground)" />
              <ellipse cx="140" cy="98" rx="5" ry="7" fill="var(--foreground)" />
            </g>
          </g>
          <path d="M105 140q13 9 26 0" stroke="var(--foreground)" strokeWidth="4" strokeLinecap="round" />
          <circle cx="76" cy="137" r="5" fill="var(--mint)" />
          <circle cx="160" cy="137" r="5" fill="var(--mint)" />
        </g>
      </svg>
    </div>
  );
}
```

Pupils remain fully inside the eye shapes: horizontal radius 5 + max shift 6 < eye radius 14; vertical radius 7 + max shift 4 < eye radius 17. No SVG clipping IDs are required, so there is no ID collision on retained/mounted pages.

Create `app/login/login-mascot.css`:

```css
.login-mascot {
  --mascot-eye-x: 0px;
  --mascot-eye-y: 0px;
  --mascot-head-x: 0px;
  --mascot-head-y: 0px;
  --mascot-rotate: 0deg;
  position: relative;
  z-index: 1;
  width: 220px;
  height: 190px;
  pointer-events: none;
}
.login-mascot > svg { display: block; width: 100%; height: 100%; overflow: visible; }
.login-mascot-head {
  transform: translate(var(--mascot-head-x), var(--mascot-head-y)) rotate(var(--mascot-rotate));
  transform-origin: 120px 105px;
  transition: transform 120ms ease-out;
}
.login-mascot-pupils {
  transform: translate(var(--mascot-eye-x), var(--mascot-eye-y));
  transition: transform 120ms ease-out;
}
.login-mascot-blink {
  transform-origin: 118px 97px;
  animation: nail-mascot-blink 6s infinite;
}
@keyframes nail-mascot-blink {
  0%, 92%, 96%, 100% { transform: scaleY(1); }
  94% { transform: scaleY(0.08); }
}
@media (max-width: 820px) {
  .login-page .login-showcase {
    display: flex;
    min-height: 0;
    padding: 8px 20px;
    border-right: 0;
    border-bottom: 2px solid var(--line);
  }
  .login-page .login-showcase-label,
  .login-page .login-showcase h2,
  .login-page .login-showcase-description,
  .login-page .login-showcase-footer,
  .login-page .login-art-orbit { display: none; }
  .login-page .login-art { min-height: 160px; margin: 0; }
  .login-page .login-panel { border-top: 0; }
  .login-mascot { width: 180px; height: 156px; }
}
@media (prefers-reduced-motion: reduce), (hover: none), (pointer: coarse) {
  .login-mascot-blink { animation: none; }
  .login-mascot-head, .login-mascot-pupils { transition: none; }
}
```

Run focused component test; expected one pass, SSR does not access browser APIs. Then commit component/CSS/test only.

```sh
git add app/login/login-mascot.tsx app/login/login-mascot.css tests/ui/login-mascot.test.tsx
git -c user.name=julianreza -c user.email=rhezandroid@gmail.com commit -m "feat: draw original Nail login mascot"
```

## Task 4 — Login integration (2–5 minutes)

Add to `tests/ui/login-page.test.tsx` before changing the page:

```tsx
it("uses the cursor mascot only for the large art and preserves the header brand", () => {
  const markup = renderToStaticMarkup(createElement(LoginPage));
  expect(markup.match(/data-login-mascot/g)).toHaveLength(1);
  expect(markup).toContain('class="workspace-brand-mark"');
  expect(markup).not.toContain('class="login-art-core"');
  expect(markup).not.toContain("login-art-chip");
});
```

Run login test; expected failure (no mascot yet).

In `app/login/page.tsx`, add:

```tsx
import LoginMascot from "./login-mascot";
```

Replace only this existing span:

```tsx
<span className="login-art-core">N<span>MAKE ROOM FOR PROGRESS</span></span>
```

with:

```tsx
<LoginMascot />
```

Remove exactly the three `.login-art-chip` spans below it. In `app/login/login.css`, delete the unused `.login-art-core`, `.login-art-core > span`, `.login-art-chip`, three chip variant rules and the two chip rules in the <=1000px media block. Leave header `.workspace-brand-mark` and login form styling alone. The new CSS uses higher specificity for mobile showcase overrides, so no root-wide CSS restructuring or loader change is needed.

Run:

```sh
node /home/ubuntu/Project/nail/node_modules/vitest/vitest.mjs run tests/ui/login-page.test.tsx tests/ui/login-mascot.test.tsx tests/ui/mascot-pose.test.ts tests/ui/mascot-tracking.test.ts
node /home/ubuntu/Project/nail/node_modules/eslint/bin/eslint.js app/login tests/ui
```

Expected: all focused cases pass, lint exit 0. Commit only integration changes:

```sh
git add app/login/page.tsx app/login/login.css tests/ui/login-page.test.tsx
git -c user.name=julianreza -c user.email=rhezandroid@gmail.com commit -m "feat: place cursor-following mascot in login showcase"
```

## Task 5 — Real browser regression script (2–5 minutes)

Create `scripts/login-mascot-browser-check.cjs` with this complete script. It visits only the public login page and does not read a password, log in or mutate the application database. Write this script before claiming the visual/movement acceptance criteria; it is the gate for CSS/rendering behavior.

```js
const assert = require("node:assert/strict");
const { chromium } = require(process.env.NAIL_PLAYWRIGHT_MODULE || "playwright");
const base = process.env.NAIL_UI_URL;
if (!base) throw new Error("Set NAIL_UI_URL to the loopback preview origin");
(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(base + "/login", { waitUntil: "networkidle" });
      const mascot = page.locator("[data-login-mascot]");
      await mascot.waitFor({ state: "visible" });
      assert.equal(await mascot.count(), 1);
      assert.equal(await page.locator(".workspace-brand-mark").innerText(), "N");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator("#password").getAttribute("type"), "password");
      await page.screenshot({ path: `${process.env.TMPDIR || "."}/nail-cursor-mascot-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto(base + "/login", { waitUntil: "networkidle" });
    const mascot = page.locator("[data-login-mascot]");
    const rect = await mascot.boundingBox();
    assert.ok(rect);
    await page.mouse.move(rect.x - 20, rect.y + rect.height / 2);
    await page.waitForFunction(() => document.querySelector("[data-login-mascot]").style.getPropertyValue("--mascot-eye-x") === "-6px");
    await page.waitForFunction(() => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector(".login-mascot-pupils")).transform).m41 + 6) < 0.01);
    await page.locator(".login-mascot-pupils").screenshot({ path: `${process.env.TMPDIR || "."}/nail-mascot-gaze-left.png` });
    await page.mouse.move(rect.x + rect.width + 20, rect.y + rect.height / 2);
    await page.waitForFunction(() => document.querySelector("[data-login-mascot]").style.getPropertyValue("--mascot-eye-x") === "6px");
    await page.waitForFunction(() => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector(".login-mascot-pupils")).transform).m41 - 6) < 0.01);
    await page.locator(".login-mascot-pupils").screenshot({ path: `${process.env.TMPDIR || "."}/nail-mascot-gaze-right.png` });
    const rightTransform = await page.locator(".login-mascot-pupils").evaluate((el) => getComputedStyle(el).transform);
    assert.notEqual(rightTransform, "none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.querySelector("[data-login-mascot]").style.getPropertyValue("--mascot-eye-x") === "0px");
    await page.mouse.move(10, 10);
    assert.equal(await mascot.evaluate((el) => el.style.getPropertyValue("--mascot-eye-x")), "0px");
    assert.equal(await page.locator(".login-mascot-blink").evaluate((el) => getComputedStyle(el).animationName), "none");
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
    const touchPage = await mobile.newPage();
    await touchPage.goto(base + "/login", { waitUntil: "networkidle" });
    await touchPage.locator("[data-login-mascot]").waitFor({ state: "visible" });
    await touchPage.mouse.move(10, 10);
    assert.equal(await touchPage.locator("[data-login-mascot]").evaluate((el) => el.style.getPropertyValue("--mascot-eye-x")), "0px");
    assert.equal(await touchPage.locator(".login-mascot-blink").evaluate((el) => getComputedStyle(el).animationName), "none");
    assert.deepEqual(errors, []);
    await mobile.close();
    await context.close();
    console.log("PASS: visible SVG mascot, measurable gaze, responsive login, reduced motion, touch static fallback, no JS errors");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
```

Important: movement assertions above check applied CSS variables; visually inspect left/right eye screenshots as well so a selector/transform integration error cannot masquerade as working movement. Do not call a static frame or advancing timer evidence of movement.

Build and start an **isolated loopback-only** preview from the feature worktree:

```sh
docker build --target app -t nail-app:cursor-mascot-preview .
docker run -d --name nail-cursor-mascot-preview \
  --user 10001:10001 --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --entrypoint node \
  -p 127.0.0.1::3000 \
  --tmpfs /tmp:size=32m \
  --tmpfs /app/.next/cache:uid=10001,gid=10001,size=32m \
  nail-app:cursor-mascot-preview server.js
docker port nail-cursor-mascot-preview 3000/tcp
```

Expected: production build exit 0; a loopback ephemeral port is printed. Do not mount production data or secrets into preview. `/login` renders without owner credentials; authenticated APIs are not being exercised here. If the named preview container already exists, inspect its provenance before removing/replacing it.

On this inspected VPS, use the existing browser installation (no package installation/change to the repo):

```sh
PORT=$(docker port nail-cursor-mascot-preview 3000/tcp | python3 -c 'import sys;print(sys.stdin.read().strip().rsplit(":",1)[1])')
NAIL_UI_URL="http://127.0.0.1:$PORT" \
NAIL_PLAYWRIGHT_MODULE=/home/ubuntu/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core \
LD_LIBRARY_PATH=/home/ubuntu/.hermes/cache/scratch/nail-browser-libs/root/usr/lib/x86_64-linux-gnu \
node scripts/login-mascot-browser-check.cjs
```

Expected: one PASS line, exit 0, four full-page captures and left/right pupil captures under `$TMPDIR`. The cached browser paths were inspected when planning but are not guaranteed forever; if absent, stop and arrange an approved temporary browser tool installation outside the repo. Do not invent screenshots or silently skip this check.

Manual visual gate: open 1440px and 390px captures; confirm original bot is readable, lime/emerald matches Nail, pupils remain inside eyes, no chips obscure it, header still shows N, and password/button remain usable. On a fine-pointer browser move left/right/up/down, move outside viewport, tab through the form and switch reduced-motion on/off. Expected: directional gaze, subtle head lean, reset, unchanged form focus and static reduced-motion fallback.

If browser checks fail, use `superpowers:systematic-debugging`, write/extend the reproducing unit/browser assertion, then fix and rerun before rollout.

Commit script:

```sh
git add scripts/login-mascot-browser-check.cjs
git -c user.name=julianreza -c user.email=rhezandroid@gmail.com commit -m "test: verify login mascot movement and mobile fallback"
```

## Task 6 — Final verification and handoff (2–5 minutes)

```sh
node /home/ubuntu/Project/nail/node_modules/vitest/vitest.mjs run
node /home/ubuntu/Project/nail/node_modules/eslint/bin/eslint.js .
git diff --check
git status --short --branch
```

Expected: full suite green (opt-in sandbox may be skipped), ESLint/diff checks exit 0. Report exact counts from this run. The earlier Docker build must have succeeded on the final source tree; rebuild/recheck preview if any source changed after that build.

Perform a separate self-review if no reviewer tool is available: no new dependencies/network requests; no form/auth change; one pointer handler; one pending animation frame at most; cleanup removes listeners and cancels work; no continuous JS loop; correct touch/reduced-motion behavior. Review new files too, not only tracked diff. Report that review is by the author rather than independent.

Remove only the disposable preview container after evidence is captured:

```sh
docker rm -f nail-cursor-mascot-preview
```

Deliver: screenshot, source branch, exact tests/build/browser results, and any limitations. Do not deploy or merge merely because implementation is complete. Ask the owner to accept the visual result; if they want a different bot appearance, alter the local preview before touching production.

## Optional task 7 — Deploy only after explicit approval (2–5 minutes)

The current request is to plan feasibility/implementation, not permission to deploy. When separately authorized:

1. Inspect `/home/ubuntu/nail-deploy/compose.yaml` and current container image; do not assume production is still `9b5e79b`.
2. Back up only the Compose file to `/home/ubuntu/nail-deploy/compose.before-cursor-mascot.yaml` (do not overwrite an existing backup without checking it).
3. Give the verified app image a unique release tag, then update **only** `services.app.image` in the Compose file. Example tag: `nail-app:cursor-mascot-v1`.
4. Run from `/home/ubuntu/nail-deploy`:

```sh
docker compose config --quiet
docker compose up -d --no-deps --wait --wait-timeout 90 app
docker inspect nail-production-app-1 --format 'image={{.Config.Image}} health={{.State.Health.Status}}'
curl --noproxy '*' --cacert tls/server.crt -fsS -o /dev/null -w 'HTTPS /login: %{http_code}\n' https://43.173.12.116:8443/login
```

Expected: intended tag, healthy, HTTPS 200. Use a tracked background terminal job if required by the harness and wait for completion; do not reply to delayed internal process notifications as if the owner asked a new question.
5. Repeat `scripts/login-mascot-browser-check.cjs` with `NAIL_UI_URL=https://43.173.12.116:8443`; same expected PASS. Certificate ignoring is scoped to the browser checker; the curl check must use the existing trusted local certificate as shown.
6. Preserve password, database/secrets volumes, connector/proxy containers, existing worker state and TLS configuration. Do not mount Docker socket into app, use `down -v`, or open another public port.
7. If app/visual gate fails, restore only the backed-up app image selection and recreate **app only** with the same command; verify previous image and HTTPS 200. Keep source for diagnosis.
8. Update private deployment notes with actual commit/tag, preview and live evidence, rollback image and limits. Report merged/pushed/deployed/runtime-verified separately. Merge and push require their own authorization.

## Tests / acceptance summary

- RED→GREEN geometry: neutral, proportional, extreme clamping, NaN/Infinity/zero bounds.
- RED→GREEN controller: one-frame coalescing, latest coordinates, mouse-only tracking, media changes, hide/blur/exit reset, listener/frame cleanup.
- RED→GREEN component/integration: server-renderable decorative SVG, large N replaced once, header N and form preserved.
- Real browser: rendered pupils/head change with cursor (not just a flag), neutral reduced-motion/touch fallback, no 320px overflow, readable original bot, no JS errors.
- Build: actual Docker Next.js/Turbopack + TypeScript succeeds. A build alone is not animation verification.
- No model calls, credential reads, Rive upload, native-file editing, auth change, database migration or new dependency.

## Risks, tradeoffs and open questions

- **Visual taste:** no exact Grok reference is available. This plan intentionally defines a small original robot; owner can request a different silhouette after preview. It is not a faithful reproduction of an unseen Grok animation.
- **Mobile behavior:** phones cannot follow a nonexistent mouse cursor. Show a static expressive face; do not track touches, device orientation or password typing. A separately requested tap expression can be considered later, not included now.
- **Reduced motion:** disable autonomous blinking and pointer transforms; listening for preference changes is necessary while the page remains mounted.
- **Performance:** SVG/CSS is sufficient for this scale. Avoid React per-pointer state, WebGL, Rive/WASM, requestAnimationFrame loops that run when idle, and animation frameworks.
- **Privacy:** observe pointer coordinates only. Never inspect password value, keyboard content or form data; do not add analytics or expose cursor events outside the page.
- **CSS loader:** keep namespaced global CSS as in the repo. Prior CSS Module integration lost mappings under the custom Tailwind loader; do not change that tooling for this feature.
- **Touch / retained pages:** Next.js may preserve inactive page trees; `document.hidden` handles background tabs but not every retained hidden subtree. Cleanup handles unmount, and no animation frame runs without a pointer event. If hidden retained login pages are observed doing meaningful work, add an IntersectionObserver pause with a reproducing browser test instead of preemptive infrastructure.
- **Testing tools:** host Node/Vitest are available; Bun host CLI is not. Docker provides the declared build toolchain. Browser cache locations may expire. There is no CI browser setup being introduced here.
- **Approval:** this is a plan, not implementation. Visual acceptance, deploy, merge and push remain owner decisions. No project/production changes are made in this planning turn.
