import { getAuthHandlers } from "@/lib/server/auth/auth-runtime";
import { createProviderSetupHandler } from "@/lib/server/providers/provider-setup-handler";
import { handleDashboardRead } from "@/lib/server/dashboard/runtime";

export async function GET(request: Request): Promise<Response> {
  return handleDashboardRead("providers", request);
}

export async function POST(request: Request): Promise<Response> {
  const auth = getAuthHandlers();
  if (!auth) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return createProviderSetupHandler({
    auth,
    appOrigin: process.env.APP_ORIGIN,
    databaseUrl: process.env.DATABASE_URL,
  })(request);
}
