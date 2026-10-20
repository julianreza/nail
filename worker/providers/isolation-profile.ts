import { isAbsolute, resolve } from "node:path";
import type { SubscriptionProviderKind } from "../../lib/domain/subscription-provider";
import { SubscriptionProviderError } from "../../lib/server/providers/subscription-errors";

export interface IsolationCandidate {
  bindingId: string;
  kind: SubscriptionProviderKind;
  executable: string;
  version: string;
}

export interface VerifiedIsolationProfile extends IsolationCandidate {
  profileId: string;
  verifiedAt: string;
  expiresAt: string;
}

// Intentionally empty: no installed vendor CLI has a verified tool-denial,
// filesystem, and network-egress profile on this host. Profiles are code-reviewed
// security policy, never browser or connector configuration.
const REVIEWED_ISOLATION_PROFILES: readonly VerifiedIsolationProfile[] = [];
const BINDING_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function resolveIsolationProfile(
  candidate: IsolationCandidate,
): VerifiedIsolationProfile | null {
  if (
    !BINDING_ID.test(candidate.bindingId) ||
    !isAbsolute(candidate.executable) ||
    !candidate.version.trim()
  ) return null;

  const executable = resolve(candidate.executable);
  return REVIEWED_ISOLATION_PROFILES.find((profile) =>
    profile.bindingId === candidate.bindingId &&
    profile.kind === candidate.kind &&
    profile.executable === executable &&
    profile.version === candidate.version
  ) ?? null;
}

export function requireIsolationProfile(candidate: IsolationCandidate): VerifiedIsolationProfile {
  const profile = resolveIsolationProfile(candidate);
  if (!profile) throw new SubscriptionProviderError("tool_isolation_unverified");
  return profile;
}
