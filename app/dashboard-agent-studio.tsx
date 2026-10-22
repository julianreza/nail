"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AgentSummary } from "../lib/domain/agent";
import { getAgentSkill } from "../lib/domain/agent-skills";
import MascotIllustration from "./mascot-illustration";
import { observeRoomMotion } from "./agent-room-motion";

function toneForRole(role: string): "lime" | "violet" | "coral" | "neutral" {
  switch (role) {
    case "pm": return "lime";
    case "engineer": return "violet";
    case "qa": return "coral";
    default: return "neutral";
  }
}

export default function DashboardAgentStudio({ agents }: { agents: AgentSummary[] }) {
  const [paused, setPaused] = useState(false);
  const roomRef = useRef<HTMLDivElement>(null);
  const [{ available, reduced }, setMotion] = useState({ available: false, reduced: false });
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    return observeRoomMotion(room, setMotion);
  }, []);

  return (
    <section className="agent-studio" aria-labelledby="agent-studio-title">
      <div className="command-panel-heading">
        <h3 id="agent-studio-title">Agent studio</h3>
        <span className="agent-studio-count">{new Intl.NumberFormat("id-ID").format(agents.length)} agent tersimpan</span>
      </div>
      <p className="command-caption">Agent tersimpan, bukan status eksekusi langsung.</p>

      {agents.length === 0 ? (
        <div className="state-card agent-studio-empty">
          <h4>Belum ada agent tersimpan.</h4>
          <p>Buat agent untuk menentukan peran dan panduan konfigurasinya.</p>
        </div>
      ) : (
        <>
          <div ref={roomRef} className="agent-room" data-agent-room="true" data-motion={available && !paused ? "running" : "paused"}>
            <div className="agent-room-scenery" aria-hidden="true">
              <span className="agent-room-wall-left" />
              <span className="agent-room-wall-right" />
              <span className="agent-room-board"><i /><i /><i /></span>
              <span className="agent-room-plant" />
              <span className="agent-room-bench" />
              <span className="agent-room-floor" />
            </div>
            <div className="agent-room-lanes" aria-hidden="true">
              {agents.map((agent) => (
                <div className="agent-room-lane" data-tone={toneForRole(agent.role)} key={agent.id}>
                  <div className="agent-room-actor" data-saved-agent={agent.id}>
                    <span className="agent-room-shadow" />
                    <div className="agent-room-hop"><MascotIllustration /></div>
                  </div>
                  <span className="agent-room-name">{agent.name}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="agent-room-controls">
            <button className="agent-room-toggle" type="button" aria-label={paused ? "Lanjutkan animasi" : "Jeda animasi"}
              aria-pressed={paused} disabled={reduced} onClick={() => setPaused((value) => !value)}>
              {paused ? "Lanjutkan animasi" : "Jeda animasi"}
            </button>
            {reduced ? <p>Animasi nonaktif sesuai preferensi perangkat.</p> : null}
          </div>
          <ul aria-label="Konfigurasi agent tersimpan" className="agent-room-legend">
            {agents.map((agent) => {
              const skillNames = agent.skillIds.map((id) => getAgentSkill(id)?.name ?? "Skill tidak dikenal");
              const provider = agent.providerName
                ? `${agent.providerName} · ${agent.providerStatus ?? "status tidak diketahui"}`
                : "Belum ditautkan";
              return (
                <li key={agent.id}>
                  <article data-agent-card={agent.id}>
                    <h4>{agent.name}</h4>
                    <p className="agent-room-role">{agent.role}</p>
                    <dl className="agent-room-details">
                      <div><dt>Provider</dt><dd>{provider}</dd></div>
                      <div><dt>Model</dt><dd>{agent.model ?? "Belum dipilih"}</dd></div>
                      <div><dt>Skill</dt><dd>{skillNames.length ? skillNames.join(" · ") : "Belum ada"}</dd></div>
                    </dl>
                    {agent.providerId && agent.providerStatus !== "ready" ? (
                      <p className="agent-room-status">Provider belum siap menjalankan agent.</p>
                    ) : null}
                    {agent.providerId && !agent.modelMatchesProvider ? (
                      <p className="agent-room-status">Model agent tidak lagi cocok dengan konfigurasi provider.</p>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="agent-studio-footer">
        <p>{agents.length === 0 ? "Buat agent pertama dari halaman Agents." : "Konfigurasi tersimpan; eksekusi tetap menunggu gerbang provider."}</p>
        <Link className="command-link" href="/agents">Kelola agents <span aria-hidden="true">↗</span></Link>
      </div>
    </section>
  );
}
