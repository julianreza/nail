import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import WorkspaceShell from "../../app/workspace-shell";
import { DashboardSummary } from "../../app/dashboard-overview";

vi.mock("next/navigation", () => ({
  usePathname: () => "/providers",
  useRouter: () => ({ replace: vi.fn() }),
}));

describe("reference workspace presentation", () => {
  it("identifies the current page and retains one active navigation item and real destinations", () => {
    const markup = renderToStaticMarkup(<WorkspaceShell>Content</WorkspaceShell>);
    expect(markup).toContain('aria-label="Tampilkan navigasi"');
    expect(markup).toContain('aria-label="Tutup navigasi"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Nail — ringkasan"');
    expect(markup).toContain('class="workspace-sidebar-header"><a class="workspace-brand"');
    expect(markup).toContain("data-mascot-brand");
    expect(markup).toContain('viewBox="0 0 240 200"');
    expect(markup).not.toContain("data-mascot-gyro-toggle");
    expect(markup).toContain('aria-label="Halaman aktif"');
    expect(markup).toMatch(/aria-label="Halaman aktif"[^>]*>Providers</);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    for (const href of ["/", "/projects", "/agents", "/tasks", "/approvals", "/providers", "/settings"]) {
      expect(markup).toContain(`href="${href}"`);
    }
    expect(markup).toContain("Content");
    expect(markup).not.toContain('type="search"');
  });

  it.each([0, 7])("shows real project/agent counts in the hero and links to actual projects (%s projects)", (projectsCount) => {
    const markup = renderToStaticMarkup(createElement(DashboardSummary, {
      overview: { projectsCount, agentsCount: 2, activeRunsCount: 0, queuedRunsCount: 0, pendingApprovalsCount: 0 },
    }));
    expect(markup).toContain("data-dashboard-mascot");
    expect(markup).toContain('viewBox="0 0 240 200"');
    expect(markup).not.toContain('class="hero-emblem">N');
    expect(markup).toContain('aria-label="Status workspace"');
    expect(markup).toContain(`${projectsCount} project`);
    expect(markup).toContain("2 agent");
    expect(markup).toContain('href="/projects"');
    expect(markup).toContain("Buka projects");
    expect(markup).not.toContain("Rp");
    expect(markup).not.toContain("+24");
  });
});
