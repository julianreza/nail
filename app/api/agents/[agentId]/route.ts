import { getAgentHandlers } from "@/lib/server/agents/agent-runtime";

function unavailable(): Response {
  return Response.json(
    { error: "Authentication is not configured" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const handlers = getAgentHandlers();
  if (!handlers) return unavailable();
  const { agentId } = await params;
  return await handlers.get(agentId, request);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const handlers = getAgentHandlers();
  if (!handlers) return unavailable();
  const { agentId } = await params;
  return await handlers.update(agentId, request);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const handlers = getAgentHandlers();
  if (!handlers) return unavailable();
  const { agentId } = await params;
  return await handlers.delete(agentId, request);
}
