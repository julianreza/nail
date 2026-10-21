import { getAuthHandlers } from "@/lib/server/auth/auth-runtime";
import { createSubscriptionProviderHandler } from "@/lib/server/providers/subscription-handlers";
import { createLocalSubscriptionConnector } from "@/lib/server/providers/subscription-connector-runtime";


export async function POST(request: Request): Promise<Response> {
  const auth = getAuthHandlers();
  if (!auth) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    return await createSubscriptionProviderHandler({
      auth,
      appOrigin: process.env.APP_ORIGIN,
      databaseUrl: process.env.DATABASE_URL,
      connector: createLocalSubscriptionConnector(),
    })(request);
  } catch {
    return Response.json(
      { error: "Provider connector is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
