export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

export interface DeviceGrant {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: number;
}

export interface CodexModel {
  id: string;
  label: string;
}

export type LoginState = "pending" | "connected" | "cancelled" | "expired" | "failed";

export interface DirectAccountView {
  enabled: boolean;
  providerId: string | null;
  state: "not_configured" | "needs_login" | "connected";
  model: string | null;
  revision: number;
  inferenceReady: false;
}
