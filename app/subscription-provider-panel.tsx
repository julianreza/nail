"use client";

import { useEffect, useState, type FormEvent } from "react";

type ProviderKind = "antigravity" | "codex" | "claude";
interface SafeProvider {
  id: string;
  kind: ProviderKind | "deepseek" | null;
  name: string;
  status: string;
  model: string | null;
  connection: { state: string; reason: string | null; checkedAt: string | null } | null;
}

const PROVIDERS: Array<{
  kind: ProviderKind;
  title: string;
  description: string;
  loginNote: string;
  policyBlocked?: boolean;
}> = [
  {
    kind: "antigravity",
    title: "Antigravity",
    description: "Gunakan akun personal lewat CLI resmi `agy`; model dan autentikasi harus diverifikasi di host connector.",
    loginNote: "Instal CLI resmi, lalu selesaikan sign-in melalui alur interaktif `agy`. Nail tidak meminta atau menyimpan token.",
  },
  {
    kind: "codex",
    title: "Codex Subscription",
    description: "Binding akun ChatGPT untuk Codex CLI, terpisah dari penggunaan API key OpenAI.",
    loginNote: "Pada host connector, login melalui Codex CLI resmi (`codex login`) di home akun khusus. Jangan salin auth.json ke repo atau chat.",
  },
  {
    kind: "claude",
    title: "Claude Subscription",
    description: "Belum dapat diaktifkan sampai kebijakan resmi penggunaan subscription melalui CLI terverifikasi.",
    loginNote: "Integrasi diblokir oleh gerbang verifikasi kebijakan; jangan masukkan token/API key sebagai pengganti akun subscription.",
    policyBlocked: true,
  },
];

function getError(value: unknown): string | null {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
    ? value.error
    : null;
}

function isProviderList(value: unknown): value is SafeProvider[] {
  return Array.isArray(value) && value.every((item) =>
    typeof item === "object" && item !== null &&
    "id" in item && typeof item.id === "string" &&
    "kind" in item && (typeof item.kind === "string" || item.kind === null)
  );
}

export default function SubscriptionProviderPanel() {
  const [providers, setProviders] = useState<SafeProvider[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<ProviderKind | null>(null);
  const [values, setValues] = useState<Record<ProviderKind, { bindingId: string; model: string }>>({
    antigravity: { bindingId: "", model: "" },
    codex: { bindingId: "", model: "" },
    claude: { bindingId: "", model: "" },
  });
  const [messages, setMessages] = useState<Record<ProviderKind, string>>({
    antigravity: "",
    codex: "",
    claude: "",
  });

  useEffect(() => {
    let active = true;
    fetch("/api/providers", { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(getError(body) ?? "Data provider tidak dapat dimuat.");
        if (!isProviderList(body)) throw new Error("Format daftar provider tidak valid.");
        if (active) {
          setProviders(body);
          setValues((current) => {
            const next = { ...current };
            for (const provider of body) {
              if (
                (provider.kind === "codex" || provider.kind === "antigravity" || provider.kind === "claude") &&
                provider.connection === null && provider.model && !next[provider.kind].model
              ) {
                next[provider.kind] = { ...next[provider.kind], model: provider.model };
              }
            }
            return next;
          });
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Data provider tidak dapat dimuat.");
      });
    return () => { active = false; };
  }, [refresh]);

  async function submit(kind: ProviderKind, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(kind);
    setMessages((current) => ({ ...current, [kind]: "" }));
    try {
      const response = await fetch("/api/providers/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ kind, ...values[kind] }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(getError(body) ?? "Provider tidak dapat dihubungkan.");
      const state = typeof body === "object" && body !== null && "connection" in body &&
        typeof body.connection === "object" && body.connection !== null &&
        "state" in body.connection && typeof body.connection.state === "string"
        ? body.connection.state
        : "unsupported";
      setMessages((current) => ({ ...current, [kind]: `Binding tersimpan; status: ${state}.` }));
      setValues((current) => ({ ...current, [kind]: { bindingId: "", model: current[kind].model } }));
      setRefresh((value) => value + 1);
      window.dispatchEvent(new Event("provider-list-refresh"));
    } catch (reason) {
      setMessages((current) => ({
        ...current,
        [kind]: reason instanceof Error ? reason.message : "Provider tidak dapat dihubungkan.",
      }));
    } finally {
      setPending(null);
    }
  }

  async function act(kind: ProviderKind, providerId: string, action: "check" | "disconnect") {
    setPending(kind);
    setMessages((current) => ({ ...current, [kind]: "" }));
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(providerId)}/connection`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ action }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(getError(body) ?? "Tindakan provider gagal.");
      setMessages((current) => ({
        ...current,
        [kind]: action === "disconnect" ? "Binding lokal dilepas; akun vendor tidak di-logout." : "Status koneksi diperiksa.",
      }));
      setRefresh((value) => value + 1);
      window.dispatchEvent(new Event("provider-list-refresh"));
    } catch (reason) {
      setMessages((current) => ({
        ...current,
        [kind]: reason instanceof Error ? reason.message : "Tindakan provider gagal.",
      }));
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-label="Provider akun subscription" className="subscription-provider-panel">
      <div>
        <p className="eyebrow">AKUN SUBSCRIPTION</p>
        <h3>Akun model lokal</h3>
        <p className="page-description">
          Nail hanya menyimpan binding ID. Login dan token tetap dikelola CLI resmi di host connector.
        </p>
      </div>
      {error ? <p className="inline-status" role="alert">{error}</p> : null}
      <div className="subscription-provider-grid">
        {PROVIDERS.map((definition) => {
          const provider = providers.find((item) => item.kind === definition.kind);
          const state = provider?.connection?.state ?? (provider ? provider.status : "not_configured");
          const disabled = definition.policyBlocked === true || pending === definition.kind;
          return (
            <article className="subscription-provider-card" key={definition.kind}>
              <div className="subscription-provider-heading">
                <div>
                  <p className="eyebrow">{definition.kind.toUpperCase()}</p>
                  <h4>{definition.title}</h4>
                </div>
                <span className="subscription-provider-state">{state}</span>
              </div>
              <p className="muted-copy">{definition.description}</p>
              {definition.policyBlocked ? (
                <p className="inline-status" role="status">Integrasi dinonaktifkan sampai policy verification selesai.</p>
              ) : provider && provider.connection !== null ? (
                <div className="subscription-provider-actions">
                  <p className="muted-copy">{definition.loginNote}</p>
                  <button className="button-secondary" disabled={pending !== null} onClick={() => act(definition.kind, provider.id, "check")} type="button">
                    Periksa koneksi
                  </button>
                  <button className="button-secondary" disabled={pending !== null} onClick={() => act(definition.kind, provider.id, "disconnect")} type="button">
                    Lepas binding
                  </button>
                </div>
              ) : (
                <form className="subscription-provider-form" onSubmit={(event) => submit(definition.kind, event)}>
                  <p className="muted-copy">{definition.loginNote}</p>
                  <label htmlFor={`${definition.kind}-binding`}>Binding ID</label>
                  <input
                    autoComplete="off"
                    id={`${definition.kind}-binding`}
                    maxLength={64}
                    onChange={(event) => setValues((current) => ({
                      ...current,
                      [definition.kind]: { ...current[definition.kind], bindingId: event.target.value },
                    }))}
                    pattern="[a-z0-9][a-z0-9_-]{0,63}"
                    required
                    value={values[definition.kind].bindingId}
                  />
                  <label htmlFor={`${definition.kind}-model`}>Model ID</label>
                  <input
                    autoComplete="off"
                    id={`${definition.kind}-model`}
                    maxLength={128}
                    onChange={(event) => setValues((current) => ({
                      ...current,
                      [definition.kind]: { ...current[definition.kind], model: event.target.value },
                    }))}
                    pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
                    required
                    value={values[definition.kind].model}
                  />
                  <button className="button-primary" disabled={disabled || pending !== null} type="submit">
                    {pending === definition.kind ? "Memeriksa…" : "Simpan binding & periksa"}
                  </button>
                </form>
              )}
              {messages[definition.kind] ? (
                <p aria-live="polite" className="inline-status" role="status">{messages[definition.kind]}</p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
