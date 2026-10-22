import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SubscriptionProviderPanel from "../../app/subscription-provider-panel";

describe("subscription provider panel", () => {
  it("explains dedicated Codex OAuth and does not promise inference readiness", () => {
    const markup = renderToStaticMarkup(createElement(SubscriptionProviderPanel));
    expect(markup).toContain("CODEX_HOME=HOME");
    expect(markup).toContain("codex login status");
    expect(markup).toContain("connected bukan ready");
    expect(markup).toContain("docs/providers/codex-cli-oauth.md");
  });

  it("puts direct OAuth first and keeps CLI setup behind an optional disclosure", () => {
    const markup = renderToStaticMarkup(createElement(SubscriptionProviderPanel));
    expect(markup).toContain("Codex Subscription — tanpa CLI");
    expect(markup).toContain("Hubungkan ChatGPT");
    expect(markup).toContain("Codex CLI lama (opsional)");
  });

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
