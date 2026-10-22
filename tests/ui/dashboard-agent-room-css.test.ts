import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("agent room styles", () => {
  it("loads scoped motion with explicit pause and reduced-motion controls", () => {
    expect(readFileSync("app/globals.css", "utf8")).toContain('@import "./dashboard-agent-room.css";');
    const css = readFileSync("app/dashboard-agent-room.css", "utf8");
    for (const text of [
      "@keyframes agent-room-travel", "@keyframes agent-room-hop",
      'data-motion="running"', "animation-play-state: paused",
      "@media (prefers-reduced-motion: reduce)", "@media (max-width: 600px)",
      "hue-rotate(155deg)", "hue-rotate(285deg)",
    ]) expect(css).toContain(text);
    expect(css).not.toMatch(/transition:\s*all|will-change|@import\s+url/);
  });

  it("loads responsive agent editor and a wrapping saved-agent room", () => {
    const globals = readFileSync("app/globals.css", "utf8");
    const formCss = readFileSync("app/agents/agents.css", "utf8");
    const roomCss = readFileSync("app/dashboard-agent-room.css", "utf8");
    expect(globals).toContain('@import "./agents/agents.css";');
    expect(formCss).toContain(".agent-form-grid");
    expect(formCss).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(formCss).toContain("@media (max-width: 600px)");
    expect(formCss).toContain("overflow-wrap: anywhere");
    expect(formCss).toContain(".button-danger");
    expect(roomCss).toContain("grid-template-columns: repeat(auto-fit, minmax(120px, 1fr))");
    expect(roomCss).toContain("grid-auto-rows");
    expect(roomCss).toContain("overflow-wrap: anywhere");
  });
});
