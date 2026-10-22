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

export type CodexDirectErrorCode =
  | "disabled"
  | "invalid_request"
  | "busy"
  | "login_expired"
  | "needs_login"
  | "device_auth_unavailable"
  | "rate_limited"
  | "unsupported_protocol"
  | "unavailable"
  | "cancelled"
  | "timeout"
  | "output_limit"
  | "budget_unenforceable";

const SAFE_ERROR_MESSAGES: Record<CodexDirectErrorCode, string> = {
  disabled: "Direct Codex connection is not enabled",
  invalid_request: "Codex request is invalid",
  busy: "Codex account operation is busy",
  login_expired: "Codex login request expired",
  needs_login: "ChatGPT login is required",
  device_auth_unavailable: "ChatGPT device login is unavailable",
  rate_limited: "Codex account is rate limited",
  unsupported_protocol: "Codex response format is unsupported",
  unavailable: "Codex service is unavailable",
  cancelled: "Codex request was cancelled",
  timeout: "Codex request timed out",
  output_limit: "Codex response exceeded the allowed size",
  budget_unenforceable: "Codex output budget cannot be enforced",
};

export class CodexDirectError extends Error {
  constructor(public readonly code: CodexDirectErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "CodexDirectError";
  }
}
