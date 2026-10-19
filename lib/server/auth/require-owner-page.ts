import "server-only";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_SESSION_COOKIE_NAME } from "./auth-service";
import { getAuthHandlers } from "./auth-runtime";

export async function requireOwnerPage(): Promise<void> {
  await connection();
  const auth = getAuthHandlers();
  const token = (await cookies()).get(AUTH_SESSION_COOKIE_NAME)?.value;
  const session = await auth?.protectedResource(
    new Request("http://nail.internal/", {
      headers: token ? { cookie: `${AUTH_SESSION_COOKIE_NAME}=${token}` } : {},
    }),
  );
  if (!session?.ok) redirect("/login");
}
