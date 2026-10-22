"use client";

import type { AgentOptions, AgentView } from "../../lib/domain/agent";

export default function AgentCard({ agent, options }: { agent: AgentView; options: AgentOptions | null }) {
  const provider = options?.providers.find((item) => item.id === agent.providerId);
  const project = options?.projects.find((item) => item.id === agent.projectId);
  const modelMatchesProvider = agent.providerId === null
    ? agent.model === null
    : provider ? Boolean(provider.models.some((model) => model.id === agent.model)) : null;
  const skillNames = agent.skillIds.map((id) => options?.skills.find((skill) => skill.id === id)?.name ?? "Skill tidak dikenal");

  return (
    <article className="record-card agent-card" data-agent-id={agent.id}>
      <div className="agent-card-copy">
        <h3>{agent.name}</h3>
        <p className="agent-card-role">{agent.role}</p>
        <dl className="agent-card-details">
          <div>
            <dt>Project</dt>
            <dd>{agent.projectId === null ? "Semua project" : project?.name ?? "Project tidak ditemukan"}</dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>{provider ? `${provider.name} · ${provider.status}` : agent.providerId ? (options ? "Provider tidak tersedia di daftar opsi" : "Opsi provider belum dimuat") : "Belum ditautkan"}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{agent.model ?? "Belum dipilih"}</dd>
          </div>
          <div>
            <dt>Skill</dt>
            <dd>{skillNames.length > 0 ? skillNames.join(" · ") : "Belum ada"}</dd>
          </div>
        </dl>
        {agent.providerId && modelMatchesProvider === false ? (
          <p className="agent-form-error" role="status">Model tersimpan tidak lagi cocok dengan konfigurasi provider.</p>
        ) : null}
        {provider && provider.status !== "ready" ? (
          <p className="agent-form-hint" role="status">Konfigurasi tersimpan; provider belum siap menjalankan agent.</p>
        ) : null}
      </div>
    </article>
  );
}
