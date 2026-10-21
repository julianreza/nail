import { getAuthHandlers } from "@/lib/server/auth/auth-runtime";
import { createProjectRunsReadHandler } from "@/lib/server/dashboard/project-runs-read";
import { createRunRequestHandler } from "@/lib/server/orchestration/run-request-handler";
import { DEFAULT_ALLOWED_TOOLS, allowedRunPermissionsFromEnvironment } from "@/lib/server/orchestration/policy";
import { createProviderPlanGenerator } from "@/lib/server/orchestration/provider-plan-generator";
import { createProviderRegistry } from "@/lib/server/providers/provider-registry";
import { createSecretStoreFromEnvironment } from "@/lib/server/providers/secret-store";
import { createLocalSubscriptionConnector } from "@/lib/server/providers/subscription-connector-runtime";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const auth = getAuthHandlers();
  if (!auth) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const { projectId } = await params;
  return createProjectRunsReadHandler(auth, process.env.DATABASE_URL)(projectId, request);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
): Promise<Response> {
  const auth = getAuthHandlers();
  if (!auth) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const { projectId } = await params;
    const policy = {
      allowedTools: [...DEFAULT_ALLOWED_TOOLS],
      allowedPermissions: allowedRunPermissionsFromEnvironment(),
    };
    const connector = createLocalSubscriptionConnector();
    return await createRunRequestHandler({
      auth,
      appOrigin: process.env.APP_ORIGIN,
      databaseUrl: process.env.DATABASE_URL,
      policy,
      createPlanGenerator(database) {
        const registry = createProviderRegistry({
          database,
          connector,
          getSecretStore: createSecretStoreFromEnvironment,
        });
        return createProviderPlanGenerator(registry);
      },
    })(projectId, request);
  } catch {
    return Response.json(
      { error: "Plan request service is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
