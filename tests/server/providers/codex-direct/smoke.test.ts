import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../../scripts/codex-direct-smoke.mjs", import.meta.url));
const bun = "/home/ubuntu/.bun/bin/bun";
const cleanEnv = {
  ...process.env,
  PATH: `/home/ubuntu/.bun/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
  DATABASE_URL: "postgresql://secret-fixture.invalid/password",
  NAIL_CODEX_DIRECT_ENABLED: "",
  NAIL_CODEX_DIRECT_CLIENT_ID: "",
};

describe("Codex direct smoke CLI guard", () => {
  it("requires explicit opt-in before importing runtime or printing configuration", () => {
    const result = spawnSync(bun, [script], { encoding: "utf8", env: cleanEnv, timeout: 10_000 });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ state: "opt_in_required" });
    expect(result.stdout).not.toContain("secret-fixture");
    expect(result.stderr).toBe("");
  });

  it("supports help without loading configuration", () => {
    const result = spawnSync(bun, [script, "--help"], { encoding: "utf8", env: cleanEnv, timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--allow-live");
    expect(result.stdout).not.toContain("secret-fixture");
  });

  it("fails closed when live opt-in is explicit but provider config is disabled", () => {
    const result = spawnSync(bun, [script, "--allow-live", "--provider", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], {
      encoding: "utf8", env: cleanEnv, timeout: 10_000,
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ state: "blocked", reason: "not_configured" });
    expect(result.stdout).not.toContain("secret-fixture");
    expect(result.stderr).toBe("");
  });
});
