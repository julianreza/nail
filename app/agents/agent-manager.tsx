"use client";

import { useEffect, useState } from "react";
import type { AgentInput, AgentOptions, AgentView } from "../../lib/domain/agent";
import { parseAgentInput } from "../../lib/domain/agent";
import AgentCard from "./agent-card";
import AgentForm from "./agent-form";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentView(value: unknown): value is AgentView {
  if (!isRecord(value)) return false;
  const fields = ["createdAt", "id", "instructions", "model", "name", "projectId", "providerId", "revision", "role", "skillIds", "updatedAt"].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== fields.length || !actual.every((field, index) => field === fields[index])) return false;
  if (
    typeof value.id !== "string" || value.id.length === 0 ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string"
  ) return false;
  try {
    parseAgentInput({
      name: value.name,
      role: value.role,
      projectId: value.projectId,
      providerId: value.providerId,
      model: value.model,
      skillIds: value.skillIds,
      instructions: value.instructions,
    });
  } catch { return false; }
  return true;
}

function isAgentList(value: unknown): value is AgentView[] {
  return Array.isArray(value) && value.every(isAgentView);
}

function isAgentOptions(value: unknown): value is AgentOptions {
  if (!isRecord(value) || !Array.isArray(value.providers) || !Array.isArray(value.projects) || !Array.isArray(value.skills)) return false;
  return value.providers.every((item) => isRecord(item) &&
    typeof item.id === "string" && typeof item.name === "string" &&
    (typeof item.kind === "string" || item.kind === null) && typeof item.status === "string" &&
    Array.isArray(item.models) && item.models.every((model) => isRecord(model) && typeof model.id === "string" && typeof model.label === "string")) &&
    value.projects.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.name === "string") &&
    value.skills.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.name === "string" && typeof item.description === "string");
}

async function readJson(response: Response): Promise<unknown> {
  return await response.json().catch(() => null) as unknown;
}

function responseError(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : fallback;
}

export default function AgentManager() {
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [options, setOptions] = useState<AgentOptions | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<AgentView | undefined>(undefined);
  const [deleteCandidate, setDeleteCandidate] = useState<AgentView | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void fetch("/api/agents", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await readJson(response);
        if (!response.ok) throw new Error(responseError(body, "Daftar agent tidak dapat dimuat."));
        if (!isAgentList(body)) throw new Error("Format daftar agent tidak valid.");
        if (active) setAgents(body);
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) setAgentsError(error instanceof Error ? error.message : "Daftar agent tidak dapat dimuat.");
      })
      .finally(() => { if (active) setAgentsLoading(false); });

    void fetch("/api/agents/options", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await readJson(response);
        if (!response.ok) throw new Error(responseError(body, "Opsi konfigurasi agent tidak dapat dimuat."));
        if (!isAgentOptions(body)) throw new Error("Format opsi konfigurasi agent tidak valid.");
        if (active) setOptions(body);
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) setOptionsError(error instanceof Error ? error.message : "Opsi konfigurasi agent tidak dapat dimuat.");
      })
      .finally(() => { if (active) setOptionsLoading(false); });

    return () => {
      active = false;
      controller.abort();
    };
  }, [retry]);

  function reload() {
    setAgentsLoading(true);
    setOptionsLoading(true);
    setAgentsError(null);
    setOptionsError(null);
    setRetry((value) => value + 1);
  }

  async function openEditor(agent: AgentView) {
    setPending(true);
    setMutationError(null);
    setRevisionConflict(false);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, { cache: "no-store" });
      const body = await readJson(response);
      if (!response.ok || !isRecord(body) || !isAgentView(body.agent) || body.agent.id !== agent.id) {
        throw new Error(responseError(body, "Konfigurasi agent tidak dapat dimuat."));
      }
      setEditorInitial(body.agent);
      setEditorOpen(true);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Konfigurasi agent tidak dapat dimuat.");
    } finally {
      setPending(false);
    }
  }

  async function saveAgent(input: AgentInput) {
    const editing = editorInitial;
    setPending(true);
    setMutationError(null);
    setNotice(null);
    setRevisionConflict(false);
    try {
      const response = await fetch(editing ? `/api/agents/${encodeURIComponent(editing.id)}` : "/api/agents", {
        method: editing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(editing ? { revision: editing.revision, agent: input } : input),
      });
      const body = await readJson(response);
      if (!response.ok) {
        if (isRecord(body) && body.code === "revision_conflict") setRevisionConflict(true);
        throw new Error(responseError(body, "Agent tidak dapat disimpan."));
      }
      if (!isRecord(body) || !isAgentView(body.agent)) throw new Error("Respons agent tidak valid.");
      const id = editing?.id ?? body.agent.id;
      if (body.agent.id !== id) throw new Error("ID agent tidak cocok dengan perubahan yang diminta.");

      const savedResponse = await fetch(`/api/agents/${encodeURIComponent(id)}`, { cache: "no-store" });
      const savedBody = await readJson(savedResponse);
      if (!savedResponse.ok || !isRecord(savedBody) || !isAgentView(savedBody.agent) || savedBody.agent.id !== id) {
        throw new Error("Agent mungkin tersimpan, tetapi belum dapat diverifikasi. Muat ulang sebelum mencoba lagi.");
      }
      const verifiedAgent = savedBody.agent;
      const listResponse = await fetch("/api/agents", { cache: "no-store" });
      const listBody = await readJson(listResponse);
      if (!listResponse.ok || !isAgentList(listBody) || !listBody.some((agent) => agent.id === id && agent.revision === verifiedAgent.revision)) {
        throw new Error("Agent tersimpan, tetapi daftar belum dapat diverifikasi. Muat ulang sebelum mencoba lagi.");
      }

      setAgents(listBody);
      setEditorOpen(false);
      setEditorInitial(undefined);
      setNotice(editing ? "Perubahan agent tersimpan." : "Agent tersimpan.");
      window.dispatchEvent(new Event("agent-list-refresh"));
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Agent tidak dapat disimpan.");
    } finally {
      setPending(false);
    }
  }

  async function reloadLatestAgent() {
    if (!editorInitial) return;
    setPending(true);
    setMutationError(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(editorInitial.id)}`, { cache: "no-store" });
      const body = await readJson(response);
      if (!response.ok || !isRecord(body) || !isAgentView(body.agent) || body.agent.id !== editorInitial.id) {
        throw new Error(responseError(body, "Versi terbaru agent tidak dapat dimuat."));
      }
      setEditorInitial(body.agent);
      setRevisionConflict(false);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Versi terbaru agent tidak dapat dimuat.");
    } finally {
      setPending(false);
    }
  }

  async function deleteAgent(agent: AgentView) {
    setPending(true);
    setDeleteError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ revision: agent.revision }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(responseError(body, "Agent tidak dapat dihapus."));
      if (!isRecord(body) || body.deleted !== true || body.id !== agent.id) throw new Error("Respons penghapusan agent tidak valid.");

      const exactResponse = await fetch(`/api/agents/${encodeURIComponent(agent.id)}`, { cache: "no-store" });
      const exactBody = await readJson(exactResponse);
      if (exactResponse.status !== 404 || !isRecord(exactBody) || exactBody.code !== "not_found") {
        throw new Error("Penghapusan belum dapat diverifikasi; agent tetap ditampilkan.");
      }
      const listResponse = await fetch("/api/agents", { cache: "no-store" });
      const listBody = await readJson(listResponse);
      if (!listResponse.ok || !isAgentList(listBody) || listBody.some((item) => item.id === agent.id)) {
        throw new Error("Penghapusan belum dapat diverifikasi; agent tetap ditampilkan.");
      }
      setAgents(listBody);
      setDeleteCandidate(null);
      setNotice("Agent dihapus.");
      window.dispatchEvent(new Event("agent-list-refresh"));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Agent tidak dapat dihapus.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="Agents" className="section-page agent-management-page">
      <div className="dashboard-section-heading agent-management-heading">
        <div>
          <h2>Agents</h2>
          <p className="page-description">Atur peran, provider, model, dan skill panduan untuk agent tersimpan.</p>
        </div>
        <span className="agent-management-count">
          {agents === null ? "Memuat jumlah…" : `${new Intl.NumberFormat("id-ID").format(agents.length)} agent tersimpan`}
        </span>
        <button
          className="button-primary"
          disabled={options === null || optionsLoading || pending}
          onClick={() => {
            setEditorInitial(undefined);
            setEditorOpen(true);
            setMutationError(null);
            setRevisionConflict(false);
            setNotice(null);
          }}
          type="button"
        >Tambah agent</button>
      </div>

      {notice ? <p className="agent-manager-notice" role="status">{notice}</p> : null}
      {deleteCandidate ? (
        <section aria-label={`Konfirmasi hapus ${deleteCandidate.name}`} className="agent-delete-confirmation" role="alertdialog">
          <h3>Konfirmasi hapus</h3>
          <p>Yakin ingin menghapus agent <strong>{deleteCandidate.name}</strong>? Tindakan ini tidak dapat dibatalkan.</p>
          {deleteError ? <p className="agent-form-error" role="alert">{deleteError}</p> : null}
          <div className="agent-form-actions">
            <button className="button-secondary" disabled={pending} onClick={() => { setDeleteCandidate(null); setDeleteError(null); }} type="button">Batalkan penghapusan</button>
            <button className="button-danger" disabled={pending} onClick={() => void deleteAgent(deleteCandidate)} type="button">{pending ? "Menghapus…" : "Hapus agent"}</button>
          </div>
        </section>
      ) : null}
      {optionsError ? (
        <div className="state-card state-card-error" role="alert">
          <div><h3>Opsi konfigurasi tidak tersedia</h3><p>Provider, project, dan skill tidak dapat dimuat: {optionsError}</p></div>
          <button className="button-secondary" disabled={optionsLoading} onClick={reload} type="button">Coba lagi</button>
        </div>
      ) : null}

      {editorOpen && options ? (
        <section aria-labelledby="agent-editor-title" className="agent-editor-panel">
          <div className="agent-editor-heading">
            <div>
              <h3 id="agent-editor-title">{editorInitial ? "Ubah agent" : "Tambah agent"}</h3>
              <p>Pengaturan ini belum mengaktifkan inference provider.</p>
            </div>
          </div>
          {revisionConflict ? (
            <div className="state-card state-card-error" role="alert">
              <p>{mutationError}</p>
              <button className="button-secondary" disabled={pending} onClick={() => void reloadLatestAgent()} type="button">Muat versi terbaru</button>
            </div>
          ) : null}
          <AgentForm
            key={editorInitial ? `${editorInitial.id}:${editorInitial.revision}` : "new-agent"}
            error={revisionConflict ? null : mutationError}
            initial={editorInitial}
            onCancel={() => { setEditorOpen(false); setEditorInitial(undefined); setMutationError(null); setRevisionConflict(false); }}
            onSubmit={saveAgent}
            options={options}
            pending={pending}
          />
        </section>
      ) : null}

      {agentsLoading && agents === null ? (
        <div aria-label="Memuat daftar agent" aria-live="polite" className="state-card"><p>Memuat agent tersimpan…</p></div>
      ) : agentsError ? (
        <div className="state-card state-card-error" role="alert">
          <div><h3>Daftar agent belum tersedia</h3><p>{agentsError}</p></div>
          <button className="button-secondary" disabled={agentsLoading} onClick={reload} type="button">Coba lagi</button>
        </div>
      ) : agents?.length === 0 ? (
        <div className="state-card agent-empty-state">
          <div><h3>Belum ada agent tersimpan.</h3><p>Buat agent pertama untuk mengatur peran dan panduan konfigurasi.</p></div>
        </div>
      ) : (
        <>
          {agentsLoading ? <p className="agent-manager-refresh" role="status">Memperbarui daftar…</p> : null}
          <ul aria-label="Daftar agent tersimpan" className="record-list agent-list">
            {agents?.map((agent) => (
              <li key={agent.id}>
                <AgentCard
                  agent={agent}
                  onEdit={(selected) => { void openEditor(selected); }}
                  onRequestDelete={(selected) => { setDeleteCandidate(selected); setDeleteError(null); }}
                  options={options}
                  pending={pending}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
