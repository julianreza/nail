import { describe, expect, it } from "vitest";
import { SubscriptionProviderError } from "../../../lib/server/providers/subscription-errors";
import {
  requireIsolationProfile,
  resolveIsolationProfile,
} from "../../../worker/providers/isolation-profile";

describe("subscription CLI isolation policy", () => {
  for (const kind of ["codex", "antigravity", "claude"] as const) {
    it(`keeps ${kind} completion disabled until a reviewed profile exists`, () => {
      const binding = {
        bindingId: `${kind}-owner`,
        kind,
        executable: `/opt/nail-provider-bin/${kind}`,
        version: "not-installed",
      };
      expect(resolveIsolationProfile(binding)).toBeNull();
      expect(() => requireIsolationProfile(binding)).toThrowError(
        new SubscriptionProviderError("tool_isolation_unverified"),
      );
    });
  }

  it("does not accept caller-supplied claims as an isolation profile", () => {
    const untrusted = {
      bindingId: "codex-owner",
      kind: "codex" as const,
      executable: "/opt/nail-provider-bin/codex",
      version: "1.0.0",
      toolDenialsVerified: true,
      filesystemIsolationVerified: true,
      networkEgressVerified: true,
    };
    expect(resolveIsolationProfile(untrusted)).toBeNull();
  });
});
