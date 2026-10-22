import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardOperations from "../../app/dashboard-operations";

describe("dashboard operations", () => {
  it.each([0, 4, 1234])("shows actual stored queue and approval totals: %s", (count) => {
    const html = renderToStaticMarkup(createElement(DashboardOperations, {
      overview: { projectsCount: 0, agentsCount: 0, agents: [], activeRunsCount: 0, queuedRunsCount: count, pendingApprovalsCount: count },
    }));
    expect(html).toContain("Antrean &amp; keputusan");
    expect(html).toContain(`>${new Intl.NumberFormat("id-ID").format(count)}</strong>`);
    expect(html).toContain('href="/tasks"');
    expect(html).toContain('href="/approvals"');
    expect(html).toContain(count === 0 ? "Tidak ada persetujuan tertunda." : "Ada keputusan yang perlu ditinjau.");
    expect(html).toContain(count === 0 ? "Tidak ada run dalam antrean." : "Run tersimpan menunggu giliran.");
    expect(html).not.toMatch(/menit lalu|online|persen|%/i);
  });
});
