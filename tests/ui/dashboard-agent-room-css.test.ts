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
});
