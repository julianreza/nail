import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProviderSetupForm from "../../app/provider-setup-form";

describe("provider setup form", () => {
  it("renders labeled credential controls, model field, and an accessible status region", () => {
    const markup = renderToStaticMarkup(createElement(ProviderSetupForm));
    expect(markup).toContain("Konfigurasi DeepSeek");
    expect(markup).toContain('for="provider-api-key"');
    expect(markup).toContain('type="password"');
    expect(markup).toContain('for="provider-model"');
    expect(markup).toContain('aria-live="polite"');
  });
});
