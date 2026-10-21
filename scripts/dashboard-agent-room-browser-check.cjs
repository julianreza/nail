/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require(process.env.NAIL_PLAYWRIGHT_MODULE || "playwright");
const base = process.env.NAIL_UI_URL;
const state = process.env.NAIL_UI_STORAGE_STATE;
const output = process.env.TMPDIR;
if (!base || !state || !output) throw new Error("Set NAIL_UI_URL, NAIL_UI_STORAGE_STATE, and TMPDIR");
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Use a loopback preview only");

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: state, reducedMotion: "no-preference" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(base, { waitUntil: "networkidle" });
      assert.ok(!new URL(page.url()).pathname.startsWith("/login"), "Owner session missing/expired");
      const room = page.locator("[data-agent-room]");
      await room.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector("[data-agent-room]")?.dataset.motion === "running");
      assert.equal(await room.locator(".agent-room-actor").count(), 3);
      assert.equal(await page.locator(".agent-room-legend h4").allTextContents().then((x) => x.join(",")), "PM,Engineer,QA");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const filters = await room.locator(".agent-room-hop svg").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).filter));
      assert.equal(new Set(filters).size, 3);
      for (const fraction of [0, 0.25, 0.5, 0.75]) {
        await room.evaluate((element, f) => {
          for (const animation of element.getAnimations({ subtree: true })) {
            animation.pause();
            const timing = animation.effect.getTiming();
            animation.currentTime = Number(timing.duration) * f;
          }
        }, fraction);
        const inside = await room.evaluate((element) => {
          const r = element.getBoundingClientRect();
          return [...element.querySelectorAll(".agent-room-hop")].every((node) => {
            const b = node.getBoundingClientRect();
            return b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom;
          });
        });
        assert.equal(inside, true, `mascot escaped room at ${width}px, phase ${fraction}`);
      }
      await page.screenshot({ path: path.join(output, `nail-agent-room-${width}.png`), fullPage: true });
    }

    await page.goto(base, { waitUntil: "networkidle" });
    const room = page.locator("[data-agent-room]");
    await room.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector("[data-agent-room]")?.dataset.motion === "running");
    const toggle = page.locator(".agent-room-toggle");
    await toggle.focus();
    await page.keyboard.press("Space");
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    assert.equal(await room.getAttribute("data-motion"), "paused");
    assert.equal(await room.locator(".agent-room-hop").first().evaluate((node) => getComputedStyle(node).animationPlayState), "paused");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(await room.getAttribute("data-motion"), "paused", "manual pause survives visibility changes");
    await toggle.press("Enter");
    await page.waitForFunction(() => document.querySelector("[data-agent-room]")?.dataset.motion === "running");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => document.querySelector("[data-agent-room]")?.dataset.motion === "paused");
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => document.querySelector("[data-agent-room]")?.dataset.motion === "running");
    await room.evaluate((node) => { node.style.display = "none"; });
    await page.waitForFunction(() => document.querySelector("[data-agent-room]")?.dataset.motion === "paused");
    await room.evaluate((node) => { node.style.display = ""; });
    await room.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector("[data-agent-room]")?.dataset.motion === "running");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.querySelector(".agent-room-toggle")?.disabled === true);
    assert.equal(await room.getAttribute("data-motion"), "paused");
    for (const selector of [".agent-room-actor", ".agent-room-hop", ".agent-room-shadow"]) {
      assert.equal(await room.locator(selector).first().evaluate((node) => getComputedStyle(node).animationName), "none");
    }
    await page.screenshot({ path: path.join(output, "nail-agent-room-reduced.png"), fullPage: true });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => document.querySelector("[data-agent-room]")?.dataset.motion === "running");
    assert.deepEqual(errors, []);
    console.log("PASS: agent room viewports, bounded motion, colors, keyboard, visibility, reduced motion, and console");
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
