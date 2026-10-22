export const AGENT_SKILLS = [
  {
    id: "planning",
    name: "Perencanaan",
    description: "Tujuan, kriteria penerimaan, dan langkah kerja.",
    instructions: "Break the goal into small ordered tasks with explicit acceptance criteria. State assumptions and dependencies. Do not claim work has been executed.",
  },
  {
    id: "implementation",
    name: "Implementasi",
    description: "Perubahan kecil yang mengikuti pola project.",
    instructions: "Prefer the smallest change that meets the approved requirements. Follow existing project conventions. Do not expand permissions or claim unverified results.",
  },
  {
    id: "testing",
    name: "Pengujian",
    description: "Kasus normal, batas, dan kegagalan yang dapat diverifikasi.",
    instructions: "Identify normal, boundary, and failure cases. Separate proposed checks from observed results. Never invent passing test output.",
  },
  {
    id: "review",
    name: "Review",
    description: "Risiko, regresi, dan bukti hasil pekerjaan.",
    instructions: "Review against acceptance criteria and identify concrete regressions or risks. Cite the available evidence and mark anything not verified.",
  },
] as const;

export type AgentSkillId = (typeof AGENT_SKILLS)[number]["id"];

export function getAgentSkill(id: string) {
  return AGENT_SKILLS.find((skill) => skill.id === id);
}
