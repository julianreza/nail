import { accessSync, constants, statSync } from "node:fs";
import type {
  ConnectionDiagnostic,
  SubscriptionCompletion,
  SubscriptionCompletionInput,
  SubscriptionConnector,
  SubscriptionProviderKind,
} from "../../lib/domain/subscription-provider";
import { SubscriptionProviderError, type SubscriptionErrorCode } from "../../lib/server/providers/subscription-errors";
import { requireIsolationProfile } from "./isolation-profile";

export interface LocalSubscriptionBinding {
  bindingId: string;
  kind: SubscriptionProviderKind;
  executable: string;
  model: string;
}

export class LocalSubscriptionAdapter implements SubscriptionConnector {
  constructor(
    private readonly binding: LocalSubscriptionBinding,
    private readonly unsupportedReason: string,
    private readonly inferenceBlock: SubscriptionErrorCode,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async check(bindingId: string, signal: AbortSignal): Promise<ConnectionDiagnostic> {
    if (signal.aborted) throw new SubscriptionProviderError("cancelled");
    if (bindingId !== this.binding.bindingId) throw new SubscriptionProviderError("invalid_binding");
    try {
      accessSync(this.binding.executable, constants.X_OK);
      if (!statSync(this.binding.executable).isFile()) throw new Error("not executable");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          kind: this.binding.kind,
          state: "not_installed",
          reason: "cli_not_installed",
          model: null,
          checkedAt: this.clock(),
        };
      }
      return {
        kind: this.binding.kind,
        state: "unavailable",
        reason: "cli_unavailable",
        model: null,
        checkedAt: this.clock(),
      };
    }
    return {
      kind: this.binding.kind,
      state: "unsupported",
      reason: this.unsupportedReason,
      model: this.binding.model,
      checkedAt: this.clock(),
    };
  }

  async cancel(bindingId: string, signal: AbortSignal): Promise<void> {
    if (bindingId !== this.binding.bindingId) throw new SubscriptionProviderError("invalid_binding");
    if (signal.aborted) throw new SubscriptionProviderError("cancelled");
  }

  async complete(
    input: SubscriptionCompletionInput,
    signal: AbortSignal,
  ): Promise<SubscriptionCompletion> {
    if (signal.aborted) throw new SubscriptionProviderError("cancelled");
    if (input.bindingId !== this.binding.bindingId) throw new SubscriptionProviderError("invalid_binding");
    if (input.model !== this.binding.model) throw new SubscriptionProviderError("invalid_model");
    if (this.inferenceBlock === "tool_isolation_unverified") {
      requireIsolationProfile({
        bindingId: this.binding.bindingId,
        kind: this.binding.kind,
        executable: this.binding.executable,
        version: "unverified",
      });
    }
    throw new SubscriptionProviderError(this.inferenceBlock);
  }
}
