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

  async function createAgent(input: AgentInput) {
    setPending(true);
    setMutationError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(input),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(responseError(body, "Agent tidak dapat disimpan."));
      if (!isRecord(body) || !isAgentView(body.agent)) throw new Error("Respons agent tidak valid.");
      const id = body.agent.id;

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
      setNotice("Agent tersimpan.");
      window.dispatchEvent(new Event("agent-list-refresh"));
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "Agent tidak dapat disimpan.");
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
          onClick={() => { setEditorOpen(true); setMutationError(null); setNotice(null); }}
          type="button"
        >Tambah agent</button>
      </div>

      {notice ? <p className="agent-manager-notice" role="status">{notice}</p> : null}
      {optionsError ? (
        <div className="state-card state-card-error" role="alert">
          <div><h3>Opsi konfigurasi tidak tersedia</h3><p>Provider, project, dan skill tidak dapat dimuat: {optionsError}</p></div>
          <button className="button-secondary" disabled={optionsLoading} onClick={reload} type="button">Coba lagi</button>
        </div>
      ) : null}

      {editorOpen && options ? (
        <section aria-labelledby="agent-editor-title" className="agent-editor-panel">
          <div className="agent-editor-heading">
            <div><h3 id="agent-editor-title">Tambah agent</h3><p>Pengaturan ini belum mengaktifkan inference provider.</p></div>
          </div>
          <AgentForm
            error={mutationError}
            onCancel={() => { setEditorOpen(false); setMutationError(null); }}
            onSubmit={createAgent}
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
              <li key={agent.id}><AgentCard agent={agent} options={options} /></li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
