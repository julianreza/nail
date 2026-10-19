import { describe, expect, it } from "vitest";
import {
  canTransitionRunState,
  isTerminalRunState,
} from "../../lib/domain/run-state";
import { validateTaskDag } from "../../lib/domain/task-dag";
import { PROVIDER_STATUSES } from "../../lib/domain/provider-status";
import { VERIFICATION_STATUSES } from "../../lib/domain/verification-result";

describe("run state", () => {
  it("allows review to complete and rejects skipping review", () => {
    expect(canTransitionRunState("awaiting_review", "done")).toBe(true);
    expect(canTransitionRunState("running", "done")).toBe(false);
  });

  it("treats done, failed, and cancelled as terminal", () => {
    expect(isTerminalRunState("done")).toBe(true);
    expect(isTerminalRunState("failed")).toBe(true);
    expect(isTerminalRunState("cancelled")).toBe(true);
    expect(isTerminalRunState("running")).toBe(false);
  });
});

describe("validateTaskDag", () => {
  it("accepts a task chain with existing dependencies", () => {
    expect(
      validateTaskDag([
        { id: "plan", dependsOn: [] },
        { id: "build", dependsOn: ["plan"] },
      ]),
    ).toEqual({ valid: true });
  });

  it("rejects cycles, duplicate ids, and missing dependencies", () => {
    expect(
      validateTaskDag([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]).valid,
    ).toBe(false);
    expect(
      validateTaskDag([
        { id: "a", dependsOn: [] },
        { id: "a", dependsOn: [] },
      ]).valid,
    ).toBe(false);
    expect(validateTaskDag([{ id: "a", dependsOn: ["missing"] }]).valid).toBe(
      false,
    );
  });
});

describe("domain status values", () => {
  it("round-trips provider and verification statuses through JSON", () => {
    expect(JSON.parse(JSON.stringify(PROVIDER_STATUSES))).toEqual([
      "not_configured",
      "needs_login",
      "ready",
      "rate_limited",
      "unavailable",
    ]);
    expect(JSON.parse(JSON.stringify(VERIFICATION_STATUSES))).toEqual([
      "verified",
      "failed",
      "not-run",
    ]);
  });
});
