import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionProviderError } from "../../../lib/server/providers/subscription-errors";
import { runProviderProcess } from "../../../worker/providers/process-runner";

const roots: string[] = [];
const fixturePath = join(process.cwd(), "tests/fixtures/provider-cli/process.mjs");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nail-provider-process-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "empty-cwd");
  const temp = join(root, "tmp");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(temp, { mode: 0o700 });
  const spec = {
    executable: process.execPath,
    args: [fixturePath],
    cwd,
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
      TMPDIR: temp,
      OPENAI_API_KEY: "must-not-reach-child",
      ANTHROPIC_API_KEY: "must-not-reach-child",
      GEMINI_API_KEY: "must-not-reach-child",
      NAIL_DATABASE_PATH: "must-not-reach-child",
      NODE_OPTIONS: "--require=must-not-reach-child",
      HTTPS_PROXY: "https://must-not-reach-child.invalid",
    },
    stdin: "",
    timeoutMs: 2000,
    maxOutputBytes: 16 * 1024,
  };
  return { root, home, cwd, temp, spec };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("bounded provider subprocess", () => {
  it("passes prompt metacharacters only through stdin and strips credentials from the child environment", async () => {
    const { spec } = setup();
    const prompt = "; touch SHOULD_NOT_EXIST $(echo inject) `whoami`";
    const result = await runProviderProcess({
      ...spec,
      args: [fixturePath, "echo"],
      stdin: prompt,
    }, new AbortController().signal);
    const output = JSON.parse(result.stdout) as { input: string; env: Record<string, string | undefined> };
    expect(result.exitCode).toBe(0);
    expect(output.input).toBe(prompt);
    expect(output.env.HOME).toBe(spec.env.HOME);
    expect(output.env.PATH).toBeDefined();
    expect(output.env.OPENAI_API_KEY).toBeUndefined();
    expect(output.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(output.env.GEMINI_API_KEY).toBeUndefined();
    expect(output.env.NAIL_DATABASE_PATH).toBeUndefined();
    expect(output.env.NODE_OPTIONS).toBeUndefined();
    expect(output.env.HTTPS_PROXY).toBeUndefined();
  });

  it("returns a non-zero exit code without inventing provider success", async () => {
    const { spec } = setup();
    const result = await runProviderProcess({ ...spec, args: [fixturePath, "exit-seven"] }, new AbortController().signal);
    expect(result.exitCode).toBe(7);
  });

  it("kills the process group and rejects when combined output exceeds the cap", async () => {
    const { spec } = setup();
    await expect(runProviderProcess({
      ...spec,
      args: [fixturePath, "oversized"],
      maxOutputBytes: 32,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "output_limit" });
  });

  it("kills descendants on timeout and on caller cancellation", async () => {
    const { root, spec } = setup();
    const timeoutMarker = join(root, "timeout-child-ran");
    await expect(runProviderProcess({
      ...spec,
      args: [fixturePath, "spawn-descendant", timeoutMarker],
      timeoutMs: 50,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(timeoutMarker)).toBe(false);

    const cancelMarker = join(root, "cancel-child-ran");
    const controller = new AbortController();
    const running = runProviderProcess({
      ...spec,
      args: [fixturePath, "spawn-descendant", cancelMarker],
      timeoutMs: 2000,
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(cancelMarker)).toBe(false);
  });

  it("reports an absent approved client without starting a process", async () => {
    const { spec } = setup();
    await expect(runProviderProcess({
      ...spec,
      executable: join(spec.cwd, "not-installed-codex"),
    }, new AbortController().signal)).rejects.toMatchObject({ code: "not_installed" });
  });

  it("rejects a pre-aborted request before attempting process launch", async () => {
    const { spec } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(runProviderProcess({ ...spec, executable: "/missing/provider-cli" }, controller.signal))
      .rejects.toBeInstanceOf(SubscriptionProviderError);
  });
});
