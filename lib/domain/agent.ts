import { getAgentSkill } from "./agent-skills";

export interface AgentInput {
  name: string;
  role: string;
  projectId: string | null;
  providerId: string | null;
  model: string | null;
  skillIds: string[];
  instructions: string;
}

export interface AgentView extends AgentInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  projectId: string | null;
  providerId: string | null;
  providerName: string | null;
  providerStatus: string | null;
  model: string | null;
  modelMatchesProvider: boolean;
  skillIds: string[];
}

export interface AgentOptions {
  providers: Array<{
    id: string;
    name: string;
    kind: string | null;
    status: string;
    models: Array<{ id: string; label: string }>;
  }>;
  projects: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string; description: string }>;
}

const INPUT_FIELDS = [
  "instructions",
  "model",
  "name",
  "projectId",
  "providerId",
  "role",
  "skillIds",
] as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const INVALID_INSTRUCTION_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F-\u009F]/u;

function invalidAgentInput(): never {
  throw new Error("Agent input is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...INPUT_FIELDS].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function isReferenceId(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= 128 &&
    !CONTROL_CHARACTERS.test(value)
  );
}

export function parseAgentInput(value: unknown): AgentInput {
  if (!isRecord(value) || !hasExactFields(value)) return invalidAgentInput();

  const { instructions, model, name, projectId, providerId, role, skillIds } = value;
  if (
    typeof name !== "string" ||
    Array.from(name.trim()).length === 0 ||
    Array.from(name.trim()).length > 80 ||
    CONTROL_CHARACTERS.test(name)
  ) return invalidAgentInput();

  if (typeof role !== "string" || !ROLE_ID.test(role)) return invalidAgentInput();
  if (!isReferenceId(projectId) || !isReferenceId(providerId)) return invalidAgentInput();
  if (
    (model !== null && (typeof model !== "string" || !MODEL_ID.test(model))) ||
    (providerId === null && model !== null) ||
    (providerId !== null && model === null)
  ) return invalidAgentInput();
  if (
    !Array.isArray(skillIds) ||
    skillIds.length > 10 ||
    skillIds.some((id) => typeof id !== "string" || !getAgentSkill(id)) ||
    new Set(skillIds).size !== skillIds.length
  ) return invalidAgentInput();
  if (
    typeof instructions !== "string" ||
    Array.from(instructions).length > 8000 ||
    INVALID_INSTRUCTION_CONTROLS.test(instructions)
  ) return invalidAgentInput();

  return {
    name: name.trim(),
    role,
    projectId,
    providerId,
    model: model as string | null,
    skillIds: [...skillIds] as string[],
    instructions,
  };
}
