"use client";

import { useEffect, useState, type FormEvent } from "react";

interface ProviderResponse {
  error?: string;
}

export default function ProviderSetupForm() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("deepseek-chat");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/providers", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((providers: unknown) => {
        if (active && Array.isArray(providers) && providers.some((provider) =>
          typeof provider === "object" && provider !== null &&
          "name" in provider && typeof provider.name === "string" &&
          provider.name.toLowerCase() === "deepseek"
        )) {
          setConfigured(true);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    setFailed(false);
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ apiKey, model }),
      });
      const result = await response.json().catch(() => null) as ProviderResponse | null;
      if (!response.ok) throw new Error(result?.error ?? "Provider tidak dapat dikonfigurasi.");
      setApiKey("");
      setConfigured(true);
      setMessage("Koneksi DeepSeek berhasil dan provider tersimpan.");
      window.dispatchEvent(new Event("provider-list-refresh"));
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Provider tidak dapat dikonfigurasi.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="provider-setup-title" className="provider-setup-card">
      <div>
        <p className="eyebrow">KONEKSI AI</p>
        <h3 id="provider-setup-title">Konfigurasi DeepSeek</h3>
        <p className="page-description">
          API key diuji ke DeepSeek sebelum disimpan dalam bentuk terenkripsi.
        </p>
      </div>
      {configured ? (
        <p aria-live="polite" className="inline-status" role="status">
          {message || "Provider DeepSeek sudah dikonfigurasi."}
        </p>
      ) : (
      <form className="provider-setup-form" onSubmit={submit}>
        <label htmlFor="provider-model">Model DeepSeek</label>
        <input
          autoComplete="off"
          id="provider-model"
          maxLength={128}
          name="model"
          onChange={(event) => setModel(event.target.value)}
          required
          value={model}
        />
        <label htmlFor="provider-api-key">API key</label>
        <input
          autoComplete="new-password"
          id="provider-api-key"
          maxLength={16384}
          name="apiKey"
          onChange={(event) => setApiKey(event.target.value)}
          required
          type="password"
          value={apiKey}
        />
        <button className="button-primary" disabled={pending} type="submit">
          {pending ? "Memeriksa koneksi…" : "Uji koneksi & simpan"}
        </button>
        <p aria-live="polite" className="inline-status" role={failed ? "alert" : "status"}>
          {message}
        </p>
        </form>
      )}
    </section>
  );
}
