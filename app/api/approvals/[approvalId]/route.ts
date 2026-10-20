import { getAuthHandlers } from "@/lib/server/auth/auth-runtime";
import { createApprovalDecisionHandler } from "@/lib/server/orchestration/approval-action";
import { allowedRunPermissionsFromEnvironment } from "@/lib/server/orchestration/policy";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  const auth = getAuthHandlers();
  if (!auth) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const { approvalId } = await params;
    return createApprovalDecisionHandler(
      auth,
      process.env.NAIL_DATABASE_PATH,
      process.env.APP_ORIGIN,
      allowedRunPermissionsFromEnvironment(),
    )(approvalId, request);
  } catch {
    return Response.json(
      { error: "Approval service is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
