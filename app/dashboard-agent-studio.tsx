"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import MascotIllustration from "./mascot-illustration";
import { observeRoomMotion } from "./agent-room-motion";

const roles = [
  { id: "pm", name: "PM", tone: "lime", copy: "Memecah ide menjadi langkah yang jelas." },
  { id: "engineer", name: "Engineer", tone: "violet", copy: "Mengerjakan perubahan sesuai rencana." },
  { id: "qa", name: "QA", tone: "coral", copy: "Memeriksa hasil sebelum diterima." },
] as const;

export default function DashboardAgentStudio({ agentsCount }: { agentsCount: number }) {
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
        <div>
          <p className="eyebrow">KENALI PERANNYA</p>
          <h3 id="agent-studio-title">Agent studio</h3>
        </div>
        <span className="agent-studio-count">{new Intl.NumberFormat("id-ID").format(agentsCount)} agent tersimpan</span>
      </div>
      <p className="command-caption">Ilustrasi peran, bukan status agent aktif.</p>
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
          {roles.map((role) => (
            <div className="agent-room-lane" data-tone={role.tone} key={role.id}>
              <div className="agent-room-actor">
                <span className="agent-room-shadow" />
                <div className="agent-room-hop"><MascotIllustration /></div>
              </div>
              <span className="agent-room-name">{role.name}</span>
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
      <div className="agent-room-legend">
        {roles.map((role) => (
          <article key={role.id} data-agent-role={role.id}>
            <h4>{role.name}</h4>
            <p>{role.copy}</p>
          </article>
        ))}
      </div>
      <div className="agent-studio-footer">
        <p>{agentsCount === 0 ? "Belum ada agent tersimpan." : "Lihat daftar agent untuk detail konfigurasi."}</p>
        <Link className="command-link" href="/agents">Lihat agents <span aria-hidden="true">↗</span></Link>
      </div>
    </section>
  );
}
