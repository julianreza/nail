import { connection } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import LogoutButton from "./logout-button";
import { AUTH_SESSION_COOKIE_NAME } from "@/lib/server/auth/auth-service";
import { getAuthHandlers } from "@/lib/server/auth/auth-runtime";

export const instant = false;

export default async function Home() {
  await connection();
  const auth = getAuthHandlers();
  const token = (await cookies()).get(AUTH_SESSION_COOKIE_NAME)?.value;
  const sessionCheck = await auth?.protectedResource(
    new Request("http://nail.internal/", {
      headers: token ? { cookie: `${AUTH_SESSION_COOKIE_NAME}=${token}` } : {},
    }),
  );

  if (!sessionCheck || !sessionCheck.ok) {
    redirect("/login");
  }

  return (
    <main className="flex min-h-screen flex-col gap-8 p-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Nail</h1>
          <p className="text-zinc-600">Area owner</p>
        </div>
        <LogoutButton />
      </header>
      <section className="max-w-2xl rounded-2xl border border-zinc-300 bg-white p-6 shadow-lg">
        <h2 className="text-xl font-semibold">Workspace aman</h2>
        <p className="mt-2 text-zinc-600">
          Autentikasi owner aktif. Fondasi orchestrator akan dibangun di sini.
        </p>
      </section>
    </main>
  );
}
