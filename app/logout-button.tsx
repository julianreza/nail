"use client";

import { useRouter } from "next/navigation";

export default function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <button
      className="rounded-lg border border-zinc-400 px-3 py-2 text-sm font-medium"
      onClick={logout}
      type="button"
    >
      Keluar
    </button>
  );
}
