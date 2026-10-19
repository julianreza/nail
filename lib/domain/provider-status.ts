export const PROVIDER_STATUSES = [
  "not_configured",
  "needs_login",
  "ready",
  "rate_limited",
  "unavailable",
] as const;

export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];
