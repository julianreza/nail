import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravitySubscriptionAdapter } from "../../../worker/providers/antigravity-adapter";
import { ClaudeSubscriptionAdapter } from "../../../worker/providers/claude-adapter";
import { CodexSubscriptionAdapter } from "../../../worker/providers/codex-adapter";

const directories: string[] = [];
const checkedAt = "2026-10-20T00:00:00.000Z";

function binding(kind: "codex" | "antigravity" | "claude", installed = false) {
  const directory = mkdtempSync(join(tmpdir(), "nail-subscription-adapter-"));
  directories.push(directory);
  const executable = join(directory, kind === "antigravity" ? "agy" : kind);
  if (installed) {
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
  }
  return {
    bindingId: `${kind}-owner`,
    kind,
    executable,
    home: join(directory, "home"),
    model: "safe-model",
    enabled: true,
  } as const;
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("subscription account adapters without verified local clients", () => {
  it("reports Codex and Antigravity as not installed or auth-schema-unverified without claiming connected", async () => {
    const codexMissing = new CodexSubscriptionAdapter(binding("codex"), () => checkedAt);
    const codexPresent = new CodexSubscriptionAdapter(binding("codex", true), () => checkedAt);
    const antigravityMissing = new AntigravitySubscriptionAdapter(binding("antigravity"), () => checkedAt);
    const antigravityPresent = new AntigravitySubscriptionAdapter(binding("antigravity", true), () => checkedAt);
    const signal = new AbortController().signal;

    await expect(codexMissing.check("codex-owner", signal)).resolves.toMatchObject({ state: "not_installed", checkedAt });
    await expect(codexPresent.check("codex-owner", signal)).resolves.toMatchObject({ state: "unsupported", reason: "auth_status_unverified" });
    await expect(antigravityMissing.check("antigravity-owner", signal)).resolves.toMatchObject({ state: "not_installed", checkedAt });
    await expect(antigravityPresent.check("antigravity-owner", signal)).resolves.toMatchObject({ state: "unsupported", reason: "personal_auth_status_unverified" });
  });

  it("keeps Claude subscription auth blocked until official policy is verified", async () => {
    const adapter = new ClaudeSubscriptionAdapter(binding("claude", true), () => checkedAt);
    await expect(adapter.check("claude-owner", new AbortController().signal)).resolves.toMatchObject({
      state: "unsupported",
      reason: "policy_unverified",
      checkedAt,
    });
  });

  it("blocks inference for all three adapters until an isolation profile exists", async () => {
    const signal = new AbortController().signal;
    const codexBinding = binding("codex", true);
    const antigravityBinding = binding("antigravity", true);
    const claudeBinding = binding("claude", true);
    const adapters = [
      [new CodexSubscriptionAdapter(codexBinding, () => checkedAt), codexBinding.bindingId],
      [new AntigravitySubscriptionAdapter(antigravityBinding, () => checkedAt), antigravityBinding.bindingId],
      [new ClaudeSubscriptionAdapter(claudeBinding, () => checkedAt), claudeBinding.bindingId],
    ] as const;
    for (const [adapter, bindingId] of adapters) {
      await expect(adapter.complete({
        bindingId,
        prompt: "safe prompt",
        model: "safe-model",
        maxOutputTokens: 16,
      }, signal)).rejects.toMatchObject({ code: expect.stringMatching(/policy_unverified|tool_isolation_unverified/) });
    }
  });
});
