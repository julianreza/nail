import type { PlanGenerator, PlanGeneratorInput } from "./run-request";
import type { ProviderRegistry } from "../providers/provider-registry";

const MAX_PLAN_OUTPUT_BYTES = 512 * 1024;
const MAX_GENERATION_MS = 120_000;

const PLAN_INSTRUCTIONS = `You are Nail's project manager. Produce exactly one JSON object and no markdown, prose, or tool calls.
The object must contain exactly these top-level fields:
{"goal":string,"acceptanceCriteria":[{"id":string,"description":string}],"subtasks":[{"id":string,"title":string,"description":string,"ownerAgentId":string,"dependsOn":string[],"requiredTools":string[]}]}
Use only the supplied agents and allowed tools. Do not invent file contents, test results, credentials, or completed work.`;

export function createProviderPlanGenerator(
  registry: Pick<ProviderRegistry, "completeText">,
): PlanGenerator {
  return async function generatePlan(input: PlanGeneratorInput): Promise<unknown> {
    const context = {
      goal: input.goal,
      baselineCommit: input.baselineCommit,
      agents: input.agents.map(({ id, role }) => ({ id, role })),
      allowedTools: [...input.allowedTools],
    };
    const prompt = `${PLAN_INSTRUCTIONS}\n\nCONTEXT_JSON:\n${JSON.stringify(context)}`;
    if (Buffer.byteLength(prompt, "utf8") > 64 * 1024) {
      throw new Error("Provider plan request exceeds the allowed size");
    }

    const completion = await registry.completeText({
      providerId: input.providerId,
      runId: input.runId,
      prompt,
      maxOutputTokens: input.maxOutputTokens,
      signal: AbortSignal.timeout(MAX_GENERATION_MS),
    });
    if (Buffer.byteLength(completion.text, "utf8") > MAX_PLAN_OUTPUT_BYTES) {
      throw new Error("Provider plan response exceeds the allowed size");
    }

    let proposal: unknown;
    try {
      proposal = JSON.parse(completion.text);
    } catch {
      throw new Error("Provider plan response is not valid JSON");
    }
    if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) {
      throw new Error("Provider plan response is not a JSON object");
    }
    return proposal;
  };
}
