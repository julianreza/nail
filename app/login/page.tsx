import LoginForm from "./login-form";
import WorkspaceIcon from "../workspace-icon";
import "./login.css";

export default function LoginPage() {
  return (
    <main className="login-page">
      <div className="login-shell">
        <div className="login-brand-row">
          <div className="workspace-brand">
            <span className="workspace-brand-mark" aria-hidden="true">N</span>
            <span>
              <strong>Nail</strong>
              <small>Agent workspace</small>
            </span>
          </div>
          <span className="login-access-tag"><span aria-hidden="true" /> Workspace pribadi</span>
        </div>

        <section className="login-card" aria-labelledby="login-title">
          <aside className="login-showcase" aria-label="Tentang workspace Nail">
            <p className="login-showcase-label">YOUR SPACE. YOUR NEXT BIG THING.</p>
            <h2>Ide besar.<br />Mulai dari <span>sini.</span></h2>
            <p className="login-showcase-description">Ruang untuk merapikan ide, mengatur agent, dan menentukan langkah berikutnya.</p>
            <div className="login-art" aria-hidden="true">
              <div className="login-art-orbit" />
              <div className="login-art-orbit login-art-orbit-inner" />
              <span className="login-art-core">N<span>MAKE ROOM FOR PROGRESS</span></span>
              <span className="login-art-chip login-art-chip-projects">Projects ↗</span>
              <span className="login-art-chip login-art-chip-agents">✦ Agents</span>
              <span className="login-art-chip login-art-chip-approvals">✓ Approvals</span>
            </div>
            <div className="login-showcase-footer"><span aria-hidden="true">✳</span> Workspace kamu. Keputusan tetap di tanganmu.</div>
          </aside>

          <div className="login-panel">
            <header className="login-intro">
              <span className="login-lock-mark"><WorkspaceIcon name="approvals" /></span>
              <p className="eyebrow">AREA OWNER</p>
              <h1 className="login-title" id="login-title">Masuk ke workspace</h1>
              <p className="login-description">Lanjutkan dari ide terakhir kamu. Proyek, agent, dan approval ada di satu tempat.</p>
            </header>
            <div className="login-body">
              <LoginForm />
              <p className="login-access-note">Akses hanya untuk owner. Pendaftaran publik tidak tersedia.</p>
            </div>
            <div className="login-panel-footer"><span aria-hidden="true">●</span> Satu owner. Satu workspace. Kendali penuh.</div>
          </div>
        </section>
        <p className="login-caption">NAIL / PERSONAL AGENT WORKSPACE</p>
      </div>
    </main>
  );
}
