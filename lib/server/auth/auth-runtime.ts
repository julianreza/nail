import "server-only";
import {
  createAuthHandlers,
  getAuthConfigFromEnvironment,
  getSharedAuthState,
} from "./auth-service";

let authHandlers: ReturnType<typeof createAuthHandlers> | null | undefined;

export function getAuthHandlers() {
  if (authHandlers !== undefined) return authHandlers;
  const config = getAuthConfigFromEnvironment();
  authHandlers = config
    ? createAuthHandlers(config, Date.now, getSharedAuthState())
    : null;
  return authHandlers;
}
