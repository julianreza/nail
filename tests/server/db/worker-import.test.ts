import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("standalone worker database imports", () => {
  it("loads outside Next.js without credentials or a database connection", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync("bun", ["run", "worker/index.ts"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
