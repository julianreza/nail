import { handleDashboardRead } from "@/lib/server/dashboard/runtime";

export async function GET(request: Request): Promise<Response> {
  return handleDashboardRead("providers", request);
}
