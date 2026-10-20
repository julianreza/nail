import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SubscriptionProviderPanel from "../../app/subscription-provider-panel";

describe("subscription provider panel", () => {
  it("shows the three account providers, never asks for tokens, and labels incomplete availability", () => {
    const markup = renderToStaticMarkup(createElement(SubscriptionProviderPanel));
    expect(markup).toContain("Antigravity");
    expect(markup).toContain("Codex Subscription");
    expect(markup).toContain("Claude Subscription");
    expect(markup).toContain("policy verification");
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain("paste your token");
    expect(markup).toContain("binding ID");
    expect(markup).toContain("model");
  });
});
