import WorkspaceFrame from "../workspace-frame";

export const instant = false;

export default function SettingsPage() {
  return (
    <WorkspaceFrame>
      <section className="section-page">
        <div className="dashboard-section-heading">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h2>Pengaturan</h2>
            <p className="page-description">Akses dan resource workspace.</p>
          </div>
        </div>
        <div className="state-card section-empty-state">
          <span aria-hidden="true" className="empty-illustration">⚙</span>
          <div>
            <h3>Pengaturan belum tersedia</h3>
            <p>Belum ada preferensi yang tersimpan untuk ditampilkan atau diubah.</p>
          </div>
        </div>
      </section>
    </WorkspaceFrame>
  );
}
