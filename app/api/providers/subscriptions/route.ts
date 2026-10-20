import { getAuthHandlers } from "@/lib/server/auth/auth-runtime";
import { createSubscriptionProviderHandler } from "@/lib/server/providers/subscription-handlers";
import { createLocalSubscriptionConnector } from "@/lib/server/providers/subscription-connector-runtime";
import { loadConnectorConfig } from "@/worker/providers/connector-config";

export async function POST(request: Request): Promise<Response> {
  const auth = getAuthHandlers();
  if (!auth) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return createSubscriptionProviderHandler({
    auth,
    appOrigin: process.env.APP_ORIGIN,
    databasePath: process.env.NAIL_DATABASE_PATH,
    loadConfig: loadConnectorConfig,
    connector: createLocalSubscriptionConnector(),
  })(request);
}
