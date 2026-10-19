import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardSummary } from "../../app/dashboard-overview";
import { SectionEmptyState } from "../../app/section-view";

describe("workspace empty states", () => {
  it("renders only the actual zero counts and a project empty state", () => {
    const markup = renderToStaticMarkup(
      createElement(DashboardSummary, {
        overview: {
          projectsCount: 0,
          agentsCount: 0,
          activeRunsCount: 0,
          queuedRunsCount: 0,
          pendingApprovalsCount: 0,
        },
      }),
    );

    expect(markup).toContain("Belum ada project tersimpan");
    expect(markup).toContain("Mulai dari sebuah project");
    expect(markup).toContain("Sedang berjalan");
    expect(markup).not.toContain("chart");
  });

  it("renders persisted totals without substituting sample values", () => {
    const markup = renderToStaticMarkup(
      createElement(DashboardSummary, {
        overview: {
          projectsCount: 3,
          agentsCount: 2,
          activeRunsCount: 1,
          queuedRunsCount: 4,
          pendingApprovalsCount: 2,
        },
      }),
    );

    expect(markup).toContain(">3</strong>");
    expect(markup).toContain(">4</strong>");
    expect(markup).toContain("Workspace siap dipakai");
  });

  it("renders a truthful empty state for each list category", () => {
    for (const kind of ["projects", "agents", "tasks", "approvals", "providers"] as const) {
      const markup = renderToStaticMarkup(
        createElement(SectionEmptyState, { kind }),
      );
      const expectedEmptyText = {
        projects: "Belum ada project",
        agents: "Belum ada agent",
        tasks: "Belum ada task",
        approvals: "Tidak ada approval",
        providers: "Belum ada provider",
      }[kind];
      expect(markup).toContain(expectedEmptyText);
      expect(markup).not.toContain("demo");
    }
  });
});
