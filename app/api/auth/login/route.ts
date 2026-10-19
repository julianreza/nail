import { getAuthHandlers } from "@/lib/server/auth/auth-runtime";

export async function POST(request: Request): Promise<Response> {
  const auth = getAuthHandlers();
  if (!auth) {
    return Response.json(
      { error: "Authentication is not configured" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return auth.login(request);
}
