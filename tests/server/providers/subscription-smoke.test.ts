import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { join } from "node:path";

const smokeScript = join(process.cwd(), "scripts/subscription-provider-smoke.mjs");

function run(args: string[], environment: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [smokeScript, ...args], {
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH, ...environment },
    timeout: 5000,
  });
}

describe("subscription provider live smoke guard", () => {
  it("requires explicit live opt-in before reading connector configuration or opening a socket", () => {
    const result = run(["--binding", "codex-owner"], { NAIL_CONNECTOR_SOCKET: "/must-not-be-opened" });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ kind: null, state: "live_probe_requires_opt_in", probePassed: false });
    expect(result.stderr).toBe("");
  });

  it("rejects arbitrary flags and never echoes malformed binding values", () => {
    const result = run(["--binding", "../../secret", "--allow-live"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ kind: null, state: "invalid_arguments", probePassed: false });
    expect(result.stdout).not.toContain("../../secret");
  });

  it("returns a safe blocked result if live mode is opted in but no local connector is configured", () => {
    const result = run(["--binding", "codex-owner", "--allow-live"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ kind: null, state: "connector_unavailable", probePassed: false });
    expect(result.stdout).not.toContain("/home/");
  });
});
