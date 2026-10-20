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
      className="workspace-logout"
      onClick={logout}
      type="button"
    >
      Keluar
    </button>
  );
}
