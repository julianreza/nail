import { handleCodexDirectOperation } from "@/lib/server/providers/codex-direct/runtime";

export function GET(request: Request): Promise<Response> {
  return handleCodexDirectOperation("account", request);
}

export function DELETE(request: Request): Promise<Response> {
  return handleCodexDirectOperation("disconnect", request);
}
