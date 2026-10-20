import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_PROVIDER_KINDS } from "../../lib/domain/subscription-provider";
import { SubscriptionProviderError } from "../../lib/server/providers/subscription-errors";

const expectedErrors = {
  not_installed: [503, "Provider CLI is not installed"],
  needs_login: [401, "Provider account needs login"],
  wrong_auth_mode: [403, "Provider is not using the required subscription account"],
  unsupported_version: [503, "Provider CLI version is unsupported"],
  policy_unverified: [503, "Provider subscription policy is not verified"],
  tool_isolation_unverified: [503, "Provider tool isolation is not verified"],
  budget_unenforceable: [422, "Provider cannot enforce the required usage budget"],
  invalid_model: [400, "Selected model is not available"],
  rate_limited: [429, "Provider account is rate limited"],
  unavailable: [503, "Provider is unavailable"],
  invalid_output: [502, "Provider returned an invalid response"],
  cancelled: [409, "Provider request was cancelled"],
  timeout: [504, "Provider request timed out"],
  output_limit: [502, "Provider response exceeded the allowed size"],
  busy: [409, "Provider account is busy"],
  invalid_binding: [400, "Provider account binding is invalid"],
} as const;

describe("subscription provider contracts", () => {
  it("defines exactly the three supported account provider kinds", () => {
    expect(SUBSCRIPTION_PROVIDER_KINDS).toEqual(["antigravity", "codex", "claude"]);
  });

  it("maps every connector error code to a fixed safe message and status", () => {
    for (const [code, [status, message]] of Object.entries(expectedErrors)) {
      const error = new SubscriptionProviderError(code as keyof typeof expectedErrors);
      expect(error.name).toBe("SubscriptionProviderError");
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.message).toBe(message);
      expect(error.message).not.toContain("secret");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
