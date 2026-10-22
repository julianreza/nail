import { handleCodexDirectOperation } from "@/lib/server/providers/codex-direct/runtime";

export function POST(request: Request): Promise<Response> {
  return handleCodexDirectOperation("start", request);
}
