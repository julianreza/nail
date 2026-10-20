import { getAuthHandlers } from "@/lib/server/auth/auth-runtime";
import { createProjectRunsReadHandler } from "@/lib/server/dashboard/project-runs-read";

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
  return createProjectRunsReadHandler(auth, process.env.NAIL_DATABASE_PATH)(projectId, request);
}
