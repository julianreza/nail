"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestCodexJson } from "../lib/client/codex-direct-request";

interface DirectAccountView {
  enabled: boolean;
  providerId: string | null;
  state: "not_configured" | "needs_login" | "connected";
  model: string | null;
  revision: number;
  inferenceReady: false;
}
interface DirectModel { id: string; label: string }
interface LoginState {
  loginId: string;
  verificationUri: "https://auth.openai.com/codex/device";
  userCode: string;
  intervalSeconds: number;
  retryAfterSeconds: number;
  expiresAt: string;
}


function isAccount(value: unknown): value is DirectAccountView {
  return typeof value === "object" && value !== null && "enabled" in value && typeof value.enabled === "boolean" &&
    "state" in value && (value.state === "not_configured" || value.state === "needs_login" || value.state === "connected") &&
    "revision" in value && typeof value.revision === "number" &&
    "inferenceReady" in value && value.inferenceReady === false;
}

function isModels(value: unknown): value is DirectModel[] {
  return Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null &&
    "id" in item && typeof item.id === "string" && "label" in item && typeof item.label === "string");
}

export default function CodexDirectProviderCard() {
  const [account, setAccount] = useState<DirectAccountView | null>(null);
  const [models, setModels] = useState<DirectModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [login, setLogin] = useState<LoginState | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pollInFlight = useRef(false);
  const activePoll = useRef<AbortController | null>(null);

  const loadAccount = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await requestCodexJson("/api/providers/codex-direct/account", { signal });
      if (!isAccount(value)) throw new Error("Status akun Codex tidak valid.");
      setAccount(value);
      setSelectedModel(value.model ?? "");
      setError("");
      return value;
    } catch (reason) {
      if (signal?.aborted) return null;
      setError(reason instanceof Error ? reason.message : "Data akun Codex tidak dapat dimuat.");
      return null;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void loadAccount(controller.signal), 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [loadAccount]);

  useEffect(() => () => activePoll.current?.abort(), []);

  const loadModels = useCallback(async (expectedRevision: number, signal?: AbortSignal) => {
    try {
      const result = await requestCodexJson("/api/providers/codex-direct/models", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal,
        body: JSON.stringify({ expectedRevision }),
      });
      if (typeof result !== "object" || result === null || !("models" in result) || !isModels(result.models) ||
        !("account" in result) || !isAccount(result.account)) throw new Error("Daftar model Codex tidak valid.");
      setModels(result.models);
      setAccount(result.account);
      setSelectedModel(result.account.model ?? "");
      setError("");
      if (result.models.length === 0) setMessage("Tidak ada model yang tersedia.");
      return result.account;
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "Daftar model Codex tidak dapat dimuat.");
      return null;
    }
  }, []);

  const pollLogin = useCallback(async (current: LoginState, signal: AbortSignal) => {
    if (pollInFlight.current || signal.aborted) return;
    pollInFlight.current = true;
    try {
      const result = await requestCodexJson("/api/providers/codex-direct/login/poll", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal,
        body: JSON.stringify({ loginId: current.loginId }),
      });
      if (typeof result !== "object" || result === null || !("state" in result)) throw new Error("Respons login Codex tidak valid.");
      if (result.state === "pending") {
        const retryAfterSeconds = "retryAfterSeconds" in result && typeof result.retryAfterSeconds === "number"
          ? Math.min(120, Math.max(current.intervalSeconds, result.retryAfterSeconds))
          : current.intervalSeconds;
        setLogin({ ...current, retryAfterSeconds });
        setMessage("Menunggu konfirmasi login ChatGPT…");
        return;
      }
      if (result.state !== "connected") throw new Error("Login Codex tidak dapat diverifikasi.");
      const followup = new AbortController();
      activePoll.current = followup;
      setLogin(null);
      setMessage("Akun terhubung; penggunaan agent belum diaktifkan.");
      const saved = await loadAccount(followup.signal);
      if (saved?.state === "connected") await loadModels(saved.revision, followup.signal);
      window.dispatchEvent(new Event("provider-list-refresh"));
    } catch (reason) {
      if (!signal.aborted) {
        setLogin(null);
        setError(reason instanceof Error ? reason.message : "Login Codex tidak dapat diperiksa.");
      }
    } finally {
      pollInFlight.current = false;
    }
  }, [loadAccount, loadModels]);

  useEffect(() => {
    if (!login) return;
    const controller = new AbortController();
    activePoll.current = controller;
    const expirationMs = Date.parse(login.expiresAt) - Date.now();
    if (!Number.isFinite(expirationMs) || expirationMs <= 0) {
      const expiryTimer = setTimeout(() => {
        controller.abort();
        setLogin(null);
        setMessage("Kode login kedaluwarsa. Mulai koneksi lagi jika masih ingin melanjutkan.");
      }, 0);
      return () => { clearTimeout(expiryTimer); controller.abort(); };
    }
    const delayMs = Math.max(0, login.retryAfterSeconds) * 1000;
    const timer = setTimeout(() => void pollLogin(login, controller.signal), Math.min(delayMs, expirationMs));
    const expiryTimer = setTimeout(() => {
      controller.abort();
      setLogin(null);
      setMessage("Kode login kedaluwarsa. Mulai koneksi lagi jika masih ingin melanjutkan.");
    }, expirationMs);
    return () => {
      clearTimeout(timer);
      clearTimeout(expiryTimer);
      controller.abort();
      if (activePoll.current === controller) activePoll.current = null;
    };
  }, [login, pollLogin]);

  async function startLogin() {
    if (loading || login) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const result = await requestCodexJson("/api/providers/codex-direct/login/start", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", body: "{}",
      });
      if (typeof result !== "object" || result === null ||
        !("loginId" in result) || typeof result.loginId !== "string" ||
        !("verificationUri" in result) || result.verificationUri !== "https://auth.openai.com/codex/device" ||
        !("userCode" in result) || typeof result.userCode !== "string" ||
        !("intervalSeconds" in result) || typeof result.intervalSeconds !== "number" ||
        !("expiresAt" in result) || typeof result.expiresAt !== "string") throw new Error("Respons login Codex tidak valid.");
      setLogin({
        loginId: result.loginId,
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: result.userCode,
        intervalSeconds: Math.min(120, Math.max(5, result.intervalSeconds)),
        retryAfterSeconds: Math.min(120, Math.max(5, result.intervalSeconds)),
        expiresAt: result.expiresAt,
      });
      setMessage("Selesaikan login di halaman resmi ChatGPT.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Login ChatGPT tidak dapat dimulai.");
    } finally {
      setLoading(false);
    }
  }

  async function cancelLogin() {
    if (!login || loading) return;
    setLoading(true);
    activePoll.current?.abort();
    try {
      await requestCodexJson("/api/providers/codex-direct/login/cancel", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ loginId: login.loginId }),
      });
      setLogin(null);
      setMessage("Login dibatalkan.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Login Codex tidak dapat dibatalkan.");
    } finally {
      setLoading(false);
    }
  }

  async function reloadStatus() {
    if (loading) return;
    setLoading(true);
    try {
      await loadAccount();
    } finally {
      setLoading(false);
    }
  }

  async function refreshModelList() {
    if (!account || loading) return;
    setLoading(true);
    setError("");
    try {
      await loadModels(account.revision);
    } finally {
      setLoading(false);
    }
  }

  async function saveModel() {
    if (!account || !selectedModel || loading) return;
    setLoading(true);
    setError("");
    try {
      const result = await requestCodexJson("/api/providers/codex-direct/model", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ model: selectedModel, expectedRevision: account.revision }),
      });
      if (!isAccount(result)) throw new Error("Status model Codex tidak valid.");
      const readback = await loadAccount();
      if (!readback || readback.providerId !== result.providerId || readback.model !== selectedModel) {
        throw new Error("Model Codex belum terverifikasi tersimpan.");
      }
      setMessage(`Model tersimpan: ${selectedModel}`);
      window.dispatchEvent(new Event("provider-list-refresh"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Model Codex tidak dapat disimpan.");
    } finally {
      setLoading(false);
    }
  }

  async function disconnect() {
    if (!account || loading) return;
    setLoading(true);
    setError("");
    try {
      const result = await requestCodexJson("/api/providers/codex-direct/account", {
        method: "DELETE", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ expectedRevision: account.revision }),
      });
      if (!isAccount(result)) throw new Error("Status akun Codex tidak valid.");
      setAccount(result);
      setModels([]);
      setSelectedModel("");
      setConfirmDisconnect(false);
      setMessage("Binding Codex lokal dilepas; ini tidak menjamin sesi ChatGPT dicabut.");
      window.dispatchEvent(new Event("provider-list-refresh"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Koneksi Codex tidak dapat dilepas.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <article aria-label="Codex Subscription — tanpa CLI" className="subscription-provider-card">
      <div className="subscription-provider-heading">
        <div>
          <p className="eyebrow">CODEX DIRECT</p>
          <h4>Codex Subscription — tanpa CLI</h4>
        </div>
        <span className="subscription-provider-state">{account?.state ?? "memuat"}</span>
      </div>
      <p className="muted-copy">Hubungkan akun ChatGPT dari browser Nail. Token dikelola server dan disimpan terenkripsi; tidak perlu binding ID, CLI, atau API key.</p>
      {account?.enabled === false ? <p className="inline-status" role="status">Eksperimen belum diaktifkan oleh administrator.</p> : null}
      {account?.state === "connected" ? (
        <div className="subscription-provider-actions">
          <p className="inline-status" role="status">Akun terhubung; penggunaan agent belum diaktifkan.</p>
          <button className="button-secondary" disabled={loading} onClick={() => void refreshModelList()} type="button">Perbarui daftar model</button>
          {models.length === 0 ? <p className="muted-copy">Tidak ada model yang tersedia</p> : (
            <>
              <label htmlFor="codex-direct-model">Model Codex</label>
              <select id="codex-direct-model" aria-label="Model Codex" disabled={loading} onChange={(event) => setSelectedModel(event.target.value)} value={selectedModel}>
                <option value="">Pilih model dari daftar akun</option>
                {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
              </select>
              <button className="button-primary" disabled={loading || !selectedModel || selectedModel === account.model} onClick={() => void saveModel()} type="button">Simpan model</button>
            </>
          )}
          <p className="muted-copy">Model saat ini: {account.model ?? "belum dipilih"}</p>
          {confirmDisconnect ? (
            <div role="alertdialog" aria-label="Konfirmasi putus koneksi Codex">
              <p>Putuskan koneksi Codex dari Nail? Ini tidak menjamin sesi ChatGPT dicabut dari OpenAI.</p>
              <button className="button-primary" disabled={loading} onClick={() => void disconnect()} type="button">Ya, putuskan</button>
              <button className="button-secondary" disabled={loading} onClick={() => setConfirmDisconnect(false)} type="button">Batalkan</button>
            </div>
          ) : <button className="button-secondary" disabled={loading} onClick={() => setConfirmDisconnect(true)} type="button">Putuskan koneksi</button>}
        </div>
      ) : login ? (
        <div className="subscription-provider-actions">
          <p className="muted-copy">Selesaikan login di halaman resmi ChatGPT.</p>
          <a href={login.verificationUri} rel="noopener noreferrer" target="_blank">Buka halaman login ChatGPT</a>
          <p>Kode sekali pakai</p>
          <code>{login.userCode}</code>
          <p className="muted-copy">Gunakan kode ini hanya jika Anda sendiri memulai login di Nail.</p>
          <button className="button-secondary" disabled={loading} onClick={() => void cancelLogin()} type="button">Batalkan login</button>
        </div>
      ) : (
        <button className="button-primary" disabled={loading || account?.enabled === false} onClick={() => void startLogin()} type="button">
          {loading ? "Memulai…" : "Hubungkan ChatGPT"}
        </button>
      )}
      {loading ? <p className="inline-status" role="status">Memproses permintaan Codex… Maksimal 30 detik per permintaan.</p> : null}
      {message ? <p aria-live="polite" className="inline-status" role="status">{message}</p> : null}
      {error ? (
        <div>
          <p className="inline-status" role="alert">{error}</p>
          <button className="button-secondary" disabled={loading} onClick={() => void reloadStatus()} type="button">Muat ulang status</button>
        </div>
      ) : null}
    </article>
  );
}
