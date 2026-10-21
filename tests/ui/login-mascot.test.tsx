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

  it("server-renders decorative original SVG without a network asset or focus target", () => {
    const html = renderToStaticMarkup(createElement(LoginMascot));
    expect(html).toContain("data-login-mascot");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('viewBox="0 0 240 200"');
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain(".riv");
    expect(html).not.toContain("tabindex");
  });
});
