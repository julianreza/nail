import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardSummary } from "../../app/dashboard-overview";

describe("dashboard command center integration", () => {
  it("adds both panels without losing the existing empty state", () => {
    const html = renderToStaticMarkup(createElement(DashboardSummary, {
      overview: { projectsCount: 0, agentsCount: 0, agents: [], activeRunsCount: 0, queuedRunsCount: 0, pendingApprovalsCount: 0 },
    }));
    expect(html).toContain("Agent studio");
    expect(html).toContain("Antrean &amp; keputusan");
    expect(html).toContain("Belum ada project tersimpan");
    expect(html).toContain("data-dashboard-mascot");
    expect(html).toContain('class="dashboard-command-grid"');
  });

  it("loads a responsive finite-motion stylesheet with a reduced-motion override", () => {
    const globals = readFileSync("app/globals.css", "utf8");
    const css = readFileSync("app/dashboard-command-center.css", "utf8");
    expect(globals).toContain('@import "./dashboard-command-center.css";');
    expect(css).toContain("@media (max-width: 1100px)");
    expect(css).toContain("@media (max-width: 600px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none;");
    expect(css).toContain("transition: none;");
    expect(css).toContain("transform: none;");
    expect(css).toContain(".dashboard-content .agent-avatar .login-mascot-blink");
    expect(css).not.toContain("infinite");
  });
});
