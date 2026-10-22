import { describe, expect, it } from "vitest";
import { AGENT_SKILLS, getAgentSkill } from "../../lib/domain/agent-skills";
import { parseAgentInput } from "../../lib/domain/agent";

const valid = {
  name: "  Nail PM  ",
  role: "pm",
  projectId: null,
  providerId: "codex-provider",
  model: "configured-model",
  skillIds: ["planning"],
  instructions: "Keep the plan small.\nNo fabricated results.",
};

describe("agent input", () => {
  it("normalizes only the display name and preserves instructions", () => {
    expect(parseAgentInput(valid)).toEqual({ ...valid, name: "Nail PM" });
  });

  it.each([
    { ...valid, name: " " },
    { ...valid, role: "PM" },
    { ...valid, name: "x".repeat(81) },
    { ...valid, skillIds: ["planning", "planning"] },
    { ...valid, skillIds: ["unknown-skill"] },
    { ...valid, providerId: null, model: "configured-model" },
    { ...valid, providerId: "codex-provider", model: null },
    { ...valid, instructions: "x".repeat(8001) },
    { ...valid, instructions: "bad\u0000text" },
    { ...valid, ready: true },
    { ...valid, name: "Nail\u0000PM" },
    { ...valid, role: "has space" },
    { ...valid, projectId: "\nproject" },
    { ...valid, skillIds: Array.from({ length: 11 }, () => "planning") },
  ])("rejects invalid config %#", (input) => {
    expect(() => parseAgentInput(input)).toThrow("Agent input is invalid");
  });

  it("accepts exact text limits, Unicode code points, tabs, and instruction newlines", () => {
    expect(parseAgentInput({
      ...valid,
      name: "😀".repeat(80),
      instructions: `line\t${"😀".repeat(7994)}\n`,
    })).toMatchObject({ name: "😀".repeat(80), instructions: `line\t${"😀".repeat(7994)}\n` });
  });

  it("requires a known project/provider reference or explicit nulls", () => {
    expect(() => parseAgentInput({ ...valid, projectId: "" })).toThrow("Agent input is invalid");
    expect(() => parseAgentInput({ ...valid, providerId: "" })).toThrow("Agent input is invalid");
    expect(parseAgentInput({ ...valid, providerId: null, model: null })).toMatchObject({ providerId: null, model: null });
  });
});

describe("instruction skill catalogue", () => {
  it("contains only the four curated non-executable presets", () => {
    expect(AGENT_SKILLS.map(({ id, name, description }) => ({ id, name, description }))).toEqual([
      { id: "planning", name: "Perencanaan", description: "Tujuan, kriteria penerimaan, dan langkah kerja." },
      { id: "implementation", name: "Implementasi", description: "Perubahan kecil yang mengikuti pola project." },
      { id: "testing", name: "Pengujian", description: "Kasus normal, batas, dan kegagalan yang dapat diverifikasi." },
      { id: "review", name: "Review", description: "Risiko, regresi, dan bukti hasil pekerjaan." },
    ]);
    expect(getAgentSkill("planning")?.instructions).toContain("Do not claim work has been executed");
    expect(getAgentSkill("missing")).toBeUndefined();
    expect(JSON.stringify(AGENT_SKILLS)).not.toMatch(/shell|command execution|MCP/i);
  });
});
