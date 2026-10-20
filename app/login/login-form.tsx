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
    <form className="login-form" onSubmit={submit} aria-busy={pending}>
      <label className="login-label" htmlFor="password">
        Kata sandi owner
        <input
          autoComplete="current-password"
          aria-describedby="password-help"
          className="login-input"
          id="password"
          name="password"
          required
          type="password"
        />
      </label>
      <p className="login-help" id="password-help">
        Gunakan kata sandi owner untuk membuka workspace.
      </p>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="login-submit"
        disabled={pending}
        type="submit"
      >
        {pending ? "Memeriksa…" : "Masuk"}
        <span aria-hidden="true">→</span>
      </button>
    </form>
  );
}
