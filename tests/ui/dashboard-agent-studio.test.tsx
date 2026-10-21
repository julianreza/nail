import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardAgentStudio from "../../app/dashboard-agent-studio";

describe("dashboard agent studio", () => {
  it.each([0, 2, 1234])( "separates illustrated roles from %s saved agents", (agentsCount) => {
    const html = renderToStaticMarkup(createElement(DashboardAgentStudio, { agentsCount }));
    expect(html).toContain("Agent studio");
    expect(html).toContain(`${new Intl.NumberFormat("id-ID").format(agentsCount)} agent tersimpan`);
    expect(html).toContain("Ilustrasi peran, bukan status agent aktif.");
    expect(html.match(/data-agent-role=/g)).toHaveLength(3);
    for (const role of ["PM", "Engineer", "QA"]) expect(html).toContain(`>${role}</h4>`);
    expect(html).toContain('href="/agents"');
    expect(html).not.toMatch(/online|sedang bekerja|live feed/i);
    if (agentsCount === 0) expect(html).toContain("Belum ada agent tersimpan.");
  });
});
