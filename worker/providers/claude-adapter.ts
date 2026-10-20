import type { ConnectorBindingConfig } from "./connector-config";
import { LocalSubscriptionAdapter } from "./local-subscription-adapter";

export class ClaudeSubscriptionAdapter extends LocalSubscriptionAdapter {
  constructor(binding: ConnectorBindingConfig, clock?: () => string) {
    super({
      bindingId: binding.bindingId,
      kind: binding.kind,
      executable: binding.executable,
      model: binding.model,
    }, "policy_unverified", "policy_unverified", clock);
  }
}
