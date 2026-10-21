import Link from "next/link";
import MascotIllustration from "./mascot-illustration";

const roles = [
  { id: "pm", name: "PM", station: "01 / RENCANA", copy: "Memecah ide menjadi langkah yang jelas." },
  { id: "engineer", name: "Engineer", station: "02 / IMPLEMENTASI", copy: "Mengerjakan perubahan sesuai rencana." },
  { id: "qa", name: "QA", station: "03 / TINJAUAN", copy: "Memeriksa hasil sebelum diterima." },
] as const;

export default function DashboardAgentStudio({ agentsCount }: { agentsCount: number }) {
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
      <div className="agent-studio-grid">
        {roles.map((role) => (
          <article key={role.id} className="agent-role-card" data-agent-role={role.id}>
            <span className="agent-station">{role.station}</span>
            <div className="agent-avatar" aria-hidden="true"><MascotIllustration /></div>
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
