import { describe, expect, it } from "vitest";
import { isTerminalRunState } from "../../lib/domain/run-state";

describe("isTerminalRunState", () => {
  it("recognizes completed runs as terminal", () => {
    expect(isTerminalRunState("done")).toBe(true);
  });
});
