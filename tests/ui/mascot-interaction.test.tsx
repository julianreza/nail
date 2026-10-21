import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginMascot from "../../app/login/login-mascot";
import MascotIllustration from "../../app/mascot-illustration";
import { getMascotPose } from "../../app/login/mascot-pose";

const css = readFileSync("app/login/login-mascot.css", "utf8");
const referenceTheme = readFileSync("app/reference-theme.css", "utf8");
const browserChecker = readFileSync("scripts/login-mascot-browser-check.cjs", "utf8");

describe("interactive monster mascot", () => {
  it("drives antenna angle and fur response from the bounded cursor pose", () => {
    expect(getMascotPose(300, 100, { left: 100, top: 50, width: 200, height: 100 })).toMatchObject({
      eyeX: 6,
      antennaRotate: 8,
      furScale: 0.8,
    });
    expect(getMascotPose(200, 100, { left: 100, top: 50, width: 200, height: 100 })).toMatchObject({
      antennaRotate: 0,
      furScale: 0,
    });
  });

  it("separates antenna, fur, protected face, and eyelid in the shared illustration", () => {
    const html = renderToStaticMarkup(createElement(MascotIllustration));
    for (const surface of ["antenna", "fur", "face", "eyelid"]) {
      expect(html).toContain(`data-mascot-surface="${surface}"`);
    }
    expect(html.split('href="/branding/nail-monster-pupil.png"')).toHaveLength(2);
    expect(html).toContain("feDisplacementMap");
  });

  it("exposes the main mascot as a keyboard-operable click target", () => {
    const html = renderToStaticMarkup(createElement(LoginMascot));
    expect(html).toContain('data-login-mascot="true"');
    expect(html).toContain('aria-label="Putar animasi mascot"');
    expect(html).toContain('type="button"');
  });

  it("scopes browser motion assertions to the actual interactive mascot", () => {
    expect(browserChecker).toContain('[data-login-mascot] .login-mascot-pupils');
    expect(browserChecker).toContain("mascot-antenna");
    expect(browserChecker).toContain("data-mascot-fur-displacement");
    expect(browserChecker).toContain("mascot-click-bounce");
    expect(browserChecker).toContain("mascot-idle-blink");
  });

  it("styles cursor response, finite click bounce, idle blink, and larger art", () => {
    expect(css).toContain("--mascot-antenna-rotate");
    expect(css).toContain("--mascot-fur-scale");
    expect(css).toContain("mascot-click-bounce");
    expect(css).toContain("animation: mascot-idle-blink");
    expect(css).toContain("animation: mascot-idle-blink 5.8s ease-in-out infinite;");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("width: 344px;");
    expect(css).toContain("mascot-click-bounce 720ms ease-out 1 both");
    expect(referenceTheme).toContain("width: 216px;");
    expect(referenceTheme).toContain("height: 216px;");
    expect(referenceTheme).toContain("width: 175px;");
    expect(referenceTheme).toContain("height: 145px;");
  });
});
