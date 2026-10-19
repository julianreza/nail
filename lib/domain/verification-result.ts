export const VERIFICATION_STATUSES = ["verified", "failed", "not-run"] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface VerificationResult {
  status: VerificationStatus;
  detail?: string;
}
