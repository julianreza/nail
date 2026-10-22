import { getAgentHandlers } from "@/lib/server/agents/agent-runtime";

function unavailable(): Response {
  return Response.json(
    { error: "Authentication is not configured" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const handlers = getAgentHandlers();
  return handlers ? await handlers.list(request) : unavailable();
}

export async function POST(request: Request): Promise<Response> {
  const handlers = getAgentHandlers();
  return handlers ? await handlers.create(request) : unavailable();
}
