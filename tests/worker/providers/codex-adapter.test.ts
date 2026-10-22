import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { CodexSubscriptionAdapter } from "../../../worker/providers/codex-adapter";
import { SubscriptionProviderError } from "../../../lib/server/providers/subscription-errors";
import type { ProviderProcessSpec } from "../../../worker/providers/process-runner";

const binding = {
  bindingId: "codex-owner", kind: "codex" as const,
  executable: "/opt/vendor-bin/codex", home: "/private/accounts/codex-owner",
  model: "configured-model", enabled: true,
};
const checkedAt = "2026-10-21T00:00:00.000Z";
const signal = () => new AbortController().signal;

it("checks stderr auth only with isolated env and removes scratch cwd", async () => {
  let cwd = "";
  const runner = vi.fn(async (spec: ProviderProcessSpec, suppliedSignal: AbortSignal) => {
    cwd = spec.cwd;
    expect(existsSync(cwd)).toBe(true);
    expect(spec).toMatchObject({
      executable: binding.executable,
      args: ["-c", 'cli_auth_credentials_store="file"', "login", "status"],
      env: { PATH: "/usr/bin:/bin", HOME: binding.home, CODEX_HOME: binding.home, LANG: "C", LC_ALL: "C" },
      stdin: "", timeoutMs: 5000, maxOutputBytes: 8192,
    });
    expect(Object.keys(spec.env).sort()).toEqual(["CODEX_HOME", "HOME", "LANG", "LC_ALL", "PATH"]);
    expect(suppliedSignal).toBeInstanceOf(AbortSignal);
    return { stdout: "", stderr: "Logged in using ChatGPT\n", exitCode: 0 };
  });
  const result = await new CodexSubscriptionAdapter(binding, () => checkedAt, runner).check(binding.bindingId, signal());
  expect(result).toEqual({ kind: "codex", state: "connected", reason: null, model: binding.model, checkedAt });
  expect(runner).toHaveBeenCalledTimes(1);
  expect(existsSync(cwd)).toBe(false);
});

it.each([
  ["not_installed", "not_installed", "cli_not_installed"],
  ["timeout", "unavailable", "timeout"],
  ["output_limit", "unavailable", "output_limit"],
  ["invalid_binding", "unavailable", "invalid_binding"],
] as const)("maps %s without leaking output and cleans cwd", async (code, state, reason) => {
  let cwd = "";
  const runner = vi.fn(async (spec: ProviderProcessSpec) => {
    cwd = spec.cwd;
    throw new SubscriptionProviderError(code);
  });
  const result = await new CodexSubscriptionAdapter(binding, () => checkedAt, runner).check(binding.bindingId, signal());
  expect(result).toMatchObject({ state, reason, checkedAt });
  expect(existsSync(cwd)).toBe(false);
});

it("does not expose arbitrary runner exception text", async () => {
  const runner = vi.fn(async () => { throw new Error("https://sensitive.invalid/?token=secret-fixture"); });
  const result = await new CodexSubscriptionAdapter(binding, () => checkedAt, runner).check(binding.bindingId, signal());
  expect(result).toMatchObject({ state: "unavailable", reason: "unavailable" });
  expect(JSON.stringify(result)).not.toContain("secret-fixture");
});

it("rejects wrong binding and pre-abort before invoking any process", async () => {
  const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  const adapter = new CodexSubscriptionAdapter(binding, () => checkedAt, runner);
  await expect(adapter.check("other", signal())).rejects.toMatchObject({ code: "invalid_binding" });
  await expect(adapter.check(binding.bindingId, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
  expect(runner).not.toHaveBeenCalled();
});

it("propagates mid-flight cancellation and removes cwd", async () => {
  let cwd = "";
  const runner = vi.fn(async (spec: ProviderProcessSpec) => {
    cwd = spec.cwd;
    throw new SubscriptionProviderError("cancelled");
  });
  const adapter = new CodexSubscriptionAdapter(binding, () => checkedAt, runner);
  await expect(adapter.check(binding.bindingId, signal())).rejects.toMatchObject({ code: "cancelled" });
  expect(existsSync(cwd)).toBe(false);
});

it("does not run inference after a connected check", async () => {
  const runner = vi.fn(async () => ({ stdout: "", stderr: "Logged in using ChatGPT\n", exitCode: 0 }));
  const adapter = new CodexSubscriptionAdapter(binding, () => checkedAt, runner);
  await adapter.check(binding.bindingId, signal());
  await expect(adapter.complete({ bindingId: binding.bindingId, model: binding.model, prompt: "never sent", maxOutputTokens: 16 }, signal()))
    .rejects.toMatchObject({ code: "tool_isolation_unverified" });
  expect(runner).toHaveBeenCalledTimes(1);
});
