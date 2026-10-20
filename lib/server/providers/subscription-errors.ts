export const SUBSCRIPTION_PROVIDER_ERROR_CODES = [
  "not_installed",
  "needs_login",
  "wrong_auth_mode",
  "unsupported_version",
  "policy_unverified",
  "tool_isolation_unverified",
  "budget_unenforceable",
  "invalid_model",
  "rate_limited",
  "unavailable",
  "invalid_output",
  "cancelled",
  "timeout",
  "output_limit",
  "busy",
  "invalid_binding",
] as const;

export type SubscriptionErrorCode = (typeof SUBSCRIPTION_PROVIDER_ERROR_CODES)[number];

const SAFE_ERRORS: Record<SubscriptionErrorCode, { status: number; message: string }> = {
  not_installed: { status: 503, message: "Provider CLI is not installed" },
  needs_login: { status: 401, message: "Provider account needs login" },
  wrong_auth_mode: { status: 403, message: "Provider is not using the required subscription account" },
  unsupported_version: { status: 503, message: "Provider CLI version is unsupported" },
  policy_unverified: { status: 503, message: "Provider subscription policy is not verified" },
  tool_isolation_unverified: { status: 503, message: "Provider tool isolation is not verified" },
  budget_unenforceable: { status: 422, message: "Provider cannot enforce the required usage budget" },
  invalid_model: { status: 400, message: "Selected model is not available" },
  rate_limited: { status: 429, message: "Provider account is rate limited" },
  unavailable: { status: 503, message: "Provider is unavailable" },
  invalid_output: { status: 502, message: "Provider returned an invalid response" },
  cancelled: { status: 409, message: "Provider request was cancelled" },
  timeout: { status: 504, message: "Provider request timed out" },
  output_limit: { status: 502, message: "Provider response exceeded the allowed size" },
  busy: { status: 409, message: "Provider account is busy" },
  invalid_binding: { status: 400, message: "Provider account binding is invalid" },
};

export class SubscriptionProviderError extends Error {
  public readonly status: number;

  constructor(public readonly code: SubscriptionErrorCode) {
    const safeError = SAFE_ERRORS[code];
    super(safeError.message);
    this.name = "SubscriptionProviderError";
    this.status = safeError.status;
  }
}
