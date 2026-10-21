import "server-only";
import { getAuthHandlers } from "../auth/auth-runtime";
import { createDashboardReadHandlers } from "./read-api";

export type DashboardReadResource =
  | "overview"
  | "projects"
  | "agents"
  | "tasks"
  | "approvals"
  | "providers";

export async function handleDashboardRead(
  resource: DashboardReadResource,
  request: Request,
): Promise<Response> {
  const auth = getAuthHandlers();
  if (!auth) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const handlers = createDashboardReadHandlers(
    auth,
    process.env.DATABASE_URL,
  );
  return (await handlers[resource](request));
}
