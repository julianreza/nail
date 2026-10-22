import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../../lib/domain/agent";
import DashboardAgentStudio from "../../app/dashboard-agent-studio";

function agent(id: string, name: string, role = "engineer"): AgentSummary {
  return {
    id, name, role, projectId: null, providerId: null, providerName: null,
    providerStatus: null, model: null, modelMatchesProvider: true, skillIds: [],
  };
}

describe("dashboard agent studio", () => {
  it("shows no placeholder actors or cards when there are no saved agents", () => {
    const html = renderToStaticMarkup(createElement(DashboardAgentStudio, { agents: [] }));
    expect(html).toContain("0 agent tersimpan");
    expect(html).toContain("Belum ada agent tersimpan.");
    expect(html).not.toContain('data-saved-agent=');
    expect(html).not.toContain('data-agent-card=');
    expect(html).not.toMatch(/>PM<|>Engineer<|>QA</);
  });

  it("renders the exact saved agent as a decorative actor and accessible configuration card", () => {
    const saved = {
      ...agent("agent-42", "Planner milik saya", "pm"),
      providerId: "provider-1", providerName: "Codex Subscription", providerStatus: "unavailable",
      model: "configured-model", modelMatchesProvider: true, skillIds: ["planning"],
    };
    const html = renderToStaticMarkup(createElement(DashboardAgentStudio, { agents: [saved] }));
    expect(html).toContain("1 agent tersimpan");
    expect(html.match(/class="agent-room-actor"/g)).toHaveLength(1);
    expect(html).toContain('data-saved-agent="agent-42"');
    expect(html).toContain('data-agent-card="agent-42"');
    expect(html).toContain("Planner milik saya");
    expect(html).toContain("Codex Subscription · unavailable");
    expect(html).toContain("configured-model");
    expect(html).toContain("Perencanaan");
    expect(html).toContain("Agent tersimpan, bukan status eksekusi langsung.");
    expect(html).toContain("Provider belum siap menjalankan agent.");
    expect(html).not.toMatch(/online|sedang bekerja|live feed/i);
  });

  it("renders duplicate roles as separate saved agents and neutral tones for custom roles", () => {
    const agents = [
      agent("a", "PM satu", "pm"), agent("b", "PM dua", "pm"),
      agent("c", "Engineer", "engineer"), agent("d", "Security specialist", "security_review"),
    ];
    const html = renderToStaticMarkup(createElement(DashboardAgentStudio, { agents }));
    expect(html.match(/class="agent-room-actor"/g)).toHaveLength(4);
    expect(html.match(/data-agent-card=/g)).toHaveLength(4);
    expect(html).toContain('data-tone="lime"');
    expect(html).toContain('data-tone="violet"');
    expect(html).toContain('data-tone="neutral"');
    expect(html).toContain("PM satu");
    expect(html).toContain("PM dua");
    expect(html).toContain("Security specialist");
  });

  it("renders all 50 saved agent cards without truncating roster membership", () => {
    const agents = Array.from({ length: 50 }, (_, index) => agent(`agent-${index}`, `Agent ${index}`));
    const html = renderToStaticMarkup(createElement(DashboardAgentStudio, { agents }));
    expect(html).toContain("50 agent tersimpan");
    expect(html.match(/data-agent-card=/g)).toHaveLength(50);
    expect(html).toContain("Agent 49");
  });

  it("retains finite motion controls and reduced-motion friendly paused markup", () => {
    const html = renderToStaticMarkup(createElement(DashboardAgentStudio, { agents: [agent("motion", "Motion PM", "pm")] }));
    expect(html).toContain('data-agent-room="true"');
    expect(html).toContain('aria-label="Jeda animasi"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-motion="paused"');
    expect(html).toContain('aria-hidden="true"');
  });
});
