import type { ConnectorBindingConfig } from "./connector-config";
import { LocalSubscriptionAdapter } from "./local-subscription-adapter";

export class AntigravitySubscriptionAdapter extends LocalSubscriptionAdapter {
  constructor(binding: ConnectorBindingConfig, clock?: () => string) {
    super({
      bindingId: binding.bindingId,
      kind: binding.kind,
      executable: binding.executable,
      model: binding.model,
    }, "personal_auth_status_unverified", "tool_isolation_unverified", clock);
  }
}
