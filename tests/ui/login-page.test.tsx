import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import LoginPage from "../../app/login/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

describe("owner login page", () => {
  it("identifies the Nail workspace and labels the sign-in region without exposing dashboard navigation", () => {
    const markup = renderToStaticMarkup(createElement(LoginPage));
    expect(markup).toContain("Agent workspace");
    expect(markup).toContain('aria-labelledby="login-title"');
    expect(markup).toContain('id="login-title"');
    expect(markup).toContain("Pendaftaran publik tidak tersedia.");
    expect(markup).not.toContain('aria-label="Navigasi utama"');
  });

  it("keeps an accessible required password control with owner-only guidance and a submit button", () => {
    const markup = renderToStaticMarkup(createElement(LoginPage));
    expect(markup).toContain('for="password"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('autoComplete="current-password"');
    expect(markup).toContain('required=""');
    expect(markup).toContain('aria-describedby="password-help"');
    expect(markup).toContain('id="password-help"');
    expect(markup).toContain('type="submit"');
    expect(markup).not.toContain('type="email"');
  });

  it("uses the cursor mascot only for the large art and preserves the header brand", () => {
    const markup = renderToStaticMarkup(createElement(LoginPage));
    expect(markup.match(/data-login-mascot/g)).toHaveLength(1);
    expect(markup).toContain("data-mascot-brand");
    expect(markup).not.toContain('class="login-art-core"');
    expect(markup).not.toContain("login-art-chip");
  });
});
