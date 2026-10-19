"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export default function LoginForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: formData.get("password") }),
      });
      if (!response.ok) {
        setError(
          response.status === 429
            ? "Terlalu banyak percobaan. Coba lagi nanti."
            : "Login gagal. Periksa kata sandi atau konfigurasi server.",
        );
        return;
      }
      router.replace("/");
    } catch {
      setError("Tidak dapat menghubungi server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="flex w-full max-w-sm flex-col gap-4" onSubmit={submit}>
      <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="password">
        Kata sandi owner
        <input
          autoComplete="current-password"
          className="rounded-lg border border-zinc-400 px-3 py-2"
          id="password"
          name="password"
          required
          type="password"
        />
      </label>
      {error ? (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="rounded-lg bg-zinc-900 px-4 py-2 font-semibold text-white disabled:opacity-60"
        disabled={pending}
        type="submit"
      >
        {pending ? "Memeriksa…" : "Masuk"}
      </button>
    </form>
  );
}
