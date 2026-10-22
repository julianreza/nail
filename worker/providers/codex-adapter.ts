import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionDiagnostic } from "../../lib/domain/subscription-provider";
import { SubscriptionProviderError } from "../../lib/server/providers/subscription-errors";
import type { ConnectorBindingConfig } from "./connector-config";
import { parseCodexLoginStatus } from "./codex-protocol";
import { LocalSubscriptionAdapter } from "./local-subscription-adapter";
import { runProviderProcess } from "./process-runner";

export class CodexSubscriptionAdapter extends LocalSubscriptionAdapter {
  constructor(
    private readonly codexBinding: ConnectorBindingConfig,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly runner: typeof runProviderProcess = runProviderProcess,
  ) {
    super({
      bindingId: codexBinding.bindingId,
      kind: codexBinding.kind,
      executable: codexBinding.executable,
      model: codexBinding.model,
    }, "auth_status_unverified", "tool_isolation_unverified", now);
  }

  override async check(bindingId: string, signal: AbortSignal): Promise<ConnectionDiagnostic> {
    if (signal.aborted) throw new SubscriptionProviderError("cancelled");
    if (bindingId !== this.codexBinding.bindingId) throw new SubscriptionProviderError("invalid_binding");
    let cwd: string | undefined;
    try {
      cwd = await mkdtemp(join(tmpdir(), "nail-codex-status-"));
      const result = await this.runner({
        executable: this.codexBinding.executable,
        args: ["-c", 'cli_auth_credentials_store="file"', "login", "status"],
        cwd,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: this.codexBinding.home,
          CODEX_HOME: this.codexBinding.home,
          LANG: "C",
          LC_ALL: "C",
        },
        stdin: "",
        timeoutMs: 5000,
        maxOutputBytes: 8192,
      }, signal);
      return {
        kind: "codex",
        ...parseCodexLoginStatus(result),
        model: this.codexBinding.model,
        checkedAt: this.now(),
      };
    } catch (error) {
      if (signal.aborted || (error instanceof SubscriptionProviderError && error.code === "cancelled")) {
        throw new SubscriptionProviderError("cancelled");
      }
      const code = error instanceof SubscriptionProviderError ? error.code : "unavailable";
      return {
        kind: "codex",
        state: code === "not_installed" ? "not_installed" : "unavailable",
        reason: code === "not_installed" ? "cli_not_installed" : code,
        model: code === "not_installed" ? null : this.codexBinding.model,
        checkedAt: this.now(),
      };
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  }
}
