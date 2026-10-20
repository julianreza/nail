import { describe, expect, it } from "vitest";
import type { PlanGeneratorInput } from "../../../lib/server/orchestration/run-request";
import { createProviderPlanGenerator } from "../../../lib/server/orchestration/provider-plan-generator";

const plan = {
  goal: "Add a health endpoint",
  acceptanceCriteria: [{ id: "ac1", description: "Health endpoint returns 200" }],
  subtasks: [{
    id: "task1",
    title: "Add health handler",
    description: "Implement the approved health route",
    ownerAgentId: "engineer-1",
    dependsOn: [],
    requiredTools: [],
  }],
};

const input: PlanGeneratorInput = {
  runId: "run-1",
  providerId: "codex-1",
  goal: "Add a health endpoint",
  baselineCommit: "abc123",
  agents: [{ id: "engineer-1", role: "engineer" }],
  allowedTools: ["workspace:read"],
  maxOutputTokens: 4000,
};

describe("provider-routed PM plan generator", () => {
  it("sends only the approved plan context and parses one JSON object", async () => {
    let call: Record<string, unknown> | undefined;
    const generate = createProviderPlanGenerator({
      completeText: async (request) => {
        call = request as unknown as Record<string, unknown>;
        return {
          text: JSON.stringify(plan),
          model: "selected-model",
          usage: { inputTokens: 12, outputTokens: 30 },
          finishReason: "stop",
        };
      },
    });

    await expect(generate(input)).resolves.toEqual(plan);
    expect(call).toMatchObject({ runId: "run-1", providerId: "codex-1", maxOutputTokens: 4000 });
    expect(call?.prompt).toContain('"baselineCommit":"abc123"');
    expect(call?.prompt).toContain('"allowedTools":["workspace:read"]');
    expect(call?.prompt).toContain('"role":"engineer"');
    expect(call?.prompt).not.toContain("Do not disclose this label");
    expect(call?.prompt).not.toContain("/home/");
  });

  it("rejects markdown, multiple JSON objects and non-object output without repairing it", async () => {
    for (const text of [
      `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``,
      `${JSON.stringify(plan)}\n${JSON.stringify(plan)}`,
      "[]",
    ]) {
      const generate = createProviderPlanGenerator({
        completeText: async () => ({
          text,
          model: "selected-model",
          usage: { inputTokens: null, outputTokens: null },
          finishReason: "stop",
        }),
      });
      await expect(generate(input)).rejects.toThrow(/JSON/);
    }
  });
});
