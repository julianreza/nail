export const SUBSCRIPTION_PROVIDER_KINDS = [
  "antigravity",
  "codex",
  "claude",
] as const;

export type SubscriptionProviderKind = (typeof SUBSCRIPTION_PROVIDER_KINDS)[number];

export type ConnectionState =
  | "not_installed"
  | "needs_login"
  | "connected"
  | "ready"
  | "rate_limited"
  | "unavailable"
  | "unsupported";

export interface ConnectionDiagnostic {
  kind: SubscriptionProviderKind;
  state: ConnectionState;
  reason: string | null;
  model: string | null;
  checkedAt: string;
}

export interface SubscriptionCompletionInput {
  bindingId: string;
  prompt: string;
  model: string;
  maxOutputTokens: number;
}

export interface SubscriptionCompletion {
  text: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  finishReason: "stop";
}

export interface SubscriptionConnector {
  check(bindingId: string, signal: AbortSignal): Promise<ConnectionDiagnostic>;
  cancel(bindingId: string, signal: AbortSignal): Promise<void>;
  complete(
    input: SubscriptionCompletionInput,
    signal: AbortSignal,
  ): Promise<SubscriptionCompletion>;
}
