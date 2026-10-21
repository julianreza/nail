import Link from "next/link";
import type { OverviewPayload } from "./dashboard-overview";

export default function DashboardOperations({ overview }: { overview: OverviewPayload }) {
  const format = new Intl.NumberFormat("id-ID");
  return (
    <section className="dashboard-operations" aria-labelledby="dashboard-operations-title">
      <p className="eyebrow">PERLU DIPERHATIKAN</p>
      <h3 id="dashboard-operations-title">Antrean &amp; keputusan</h3>
      <p className="command-caption">Ringkasan tersimpan, bukan feed real-time.</p>
      <div className="operation-item">
        <span>Run dalam antrean</span>
        <strong>{format.format(overview.queuedRunsCount)}</strong>
        <p>{overview.queuedRunsCount === 0 ? "Tidak ada run dalam antrean." : "Run tersimpan menunggu giliran."}</p>
        <Link className="command-link" href="/tasks">Buka tasks <span aria-hidden="true">↗</span></Link>
      </div>
      <div className="operation-item">
        <span>Menunggu persetujuan</span>
        <strong>{format.format(overview.pendingApprovalsCount)}</strong>
        <p>{overview.pendingApprovalsCount === 0 ? "Tidak ada persetujuan tertunda." : "Ada keputusan yang perlu ditinjau."}</p>
        <Link className="command-link" href="/approvals">Tinjau approvals <span aria-hidden="true">↗</span></Link>
      </div>
    </section>
  );
}
