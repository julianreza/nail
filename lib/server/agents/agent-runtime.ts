import "server-only";
import { getAuthHandlers } from "../auth/auth-runtime";
import { createAgentHandlers } from "./agent-handlers";

export function getAgentHandlers() {
  const auth = getAuthHandlers();
  if (!auth) return null;
  return createAgentHandlers({
    auth,
    appOrigin: process.env.APP_ORIGIN,
    databaseUrl: process.env.DATABASE_URL,
  });
}
