// eslint-disable-next-line @typescript-eslint/no-require-imports -- This standalone .cjs runner uses Node's CommonJS loader.
const assert = require("node:assert/strict");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Playwright is resolved at runtime from an optional external module path.
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
      await page.goto(`${base}/login`, { waitUntil: "networkidle" });
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
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    const mascot = page.locator("[data-login-mascot]");
    const rect = await mascot.boundingBox();
    assert.ok(rect);
    await page.mouse.move(rect.x - rect.width, rect.y + rect.height / 2);
    await page.waitForFunction(() => document.querySelector("[data-login-mascot]").style.getPropertyValue("--mascot-eye-x") === "-6px");
    await page.waitForFunction(() => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector(".login-mascot-pupils")).transform).m41 + 6) < 0.01);
    await page.locator(".login-mascot-pupils").screenshot({ path: `${process.env.TMPDIR || "."}/nail-mascot-gaze-left.png` });
    await page.mouse.move(rect.x + rect.width * 2, rect.y + rect.height / 2);
    await page.waitForFunction(() => document.querySelector("[data-login-mascot]").style.getPropertyValue("--mascot-eye-x") === "6px");
    await page.waitForFunction(() => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector(".login-mascot-pupils")).transform).m41 - 6) < 0.01);
    await page.locator(".login-mascot-pupils").screenshot({ path: `${process.env.TMPDIR || "."}/nail-mascot-gaze-right.png` });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.querySelector("[data-login-mascot]").style.getPropertyValue("--mascot-eye-x") === "0px");
    await page.mouse.move(10, 10);
    assert.equal(await mascot.evaluate((el) => el.style.getPropertyValue("--mascot-eye-x")), "0px");
    assert.equal(await page.locator(".login-mascot-blink").evaluate((el) => getComputedStyle(el).animationName), "none");

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
    const touchPage = await mobile.newPage();
    await touchPage.goto(`${base}/login`, { waitUntil: "networkidle" });
    await touchPage.bringToFront();
    await touchPage.locator("[data-login-mascot]").waitFor({ state: "visible" });
    await touchPage.mouse.move(10, 10);
    assert.equal(await touchPage.locator("[data-login-mascot]").evaluate((el) => el.style.getPropertyValue("--mascot-eye-x")), "0px");
    assert.equal(await touchPage.locator(".login-mascot-blink").evaluate((el) => getComputedStyle(el).animationName), "none");
    assert.notEqual(await touchPage.locator(".login-mascot-pupils").evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
    await touchPage.evaluate(() => {
      Object.defineProperty(window, "DeviceOrientationEvent", {
        configurable: true,
        value: { requestPermission: async () => "granted" },
      });
    });
    const gyroToggle = touchPage.locator("[data-mascot-gyro-toggle]");
    await gyroToggle.click();
    await touchPage.waitForFunction(() => document.querySelector("[data-mascot-gyro-toggle]").getAttribute("aria-pressed") === "true");
    // Test the final sensor-driven pose deterministically; normal transition duration is asserted above.
    await touchPage.addStyleTag({ content: ".login-mascot-pupils { transition-duration: 0s !important; }" });
    await touchPage.evaluate(() => {
      for (let sample = 0; sample < 8; sample += 1) {
        setTimeout(() => {
          window.dispatchEvent(Object.assign(new Event("deviceorientation"), { beta: 15, gamma: -15 }));
        }, sample * 50);
      }
    });
    await touchPage.waitForTimeout(500);
    assert.equal(await touchPage.locator("[data-login-mascot]").evaluate((el) => el.style.getPropertyValue("--mascot-eye-x")), "-3px");
    assert.ok(await touchPage.locator(".login-mascot-pupils").evaluate((el) => Math.abs(new DOMMatrix(getComputedStyle(el).transform).m41 + 3) < 0.05));
    await gyroToggle.click();
    assert.equal(await touchPage.locator("[data-login-mascot]").evaluate((el) => el.style.getPropertyValue("--mascot-eye-x")), "0px");
    await touchPage.evaluate(() => {
      Object.defineProperty(window, "DeviceOrientationEvent", {
        configurable: true,
        value: { requestPermission: async () => "denied" },
      });
    });
    await gyroToggle.click();
    assert.match(await gyroToggle.innerText(), /Izin sensor ditolak/);
    assert.deepEqual(errors, []);
    await mobile.close();
    await context.close();
    console.log("PASS: mascot render, desktop gaze, mobile tilt opt-in/denial, responsive layout, reduced motion, no JS errors");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
