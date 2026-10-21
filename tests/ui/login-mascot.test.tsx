import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginMascot from "../../app/login/login-mascot";

describe("login mascot", () => {
  it("shows a separate opt-in control for phone motion", () => {
    const html = renderToStaticMarkup(createElement(LoginMascot));
    expect(html).toContain("data-mascot-gyro-toggle");
    expect(html).toContain("Aktifkan gerak");
    expect(html).toContain('type="button"');
  });

  it("renders an accessible interactive mascot with original artwork and independent eye layer", () => {
    const html = renderToStaticMarkup(createElement(LoginMascot));
    expect(html).toContain("data-login-mascot");
    expect(html).toContain('aria-label="Putar animasi mascot"');
    expect(html).not.toContain('aria-hidden="true"');
    expect(html).toContain('data-monster-mascot="true"');
    expect(html).toContain('viewBox="0 0 240 200"');
    expect(html.match(/<image /g)).toHaveLength(4);
    expect(html.split('href="/branding/nail-monster-body.png"')).toHaveLength(4);
    expect(html.split('href="/branding/nail-monster-pupil.png"')).toHaveLength(2);
    expect(html).toContain('data-mascot-surface="antenna"');
    expect(html).toContain('data-mascot-surface="fur"');
    expect(html).toContain('data-mascot-surface="eyelid"');
    expect(html).toContain('clip-path="url(#nail-mascot-eye-');
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain(".riv");
  });
});
