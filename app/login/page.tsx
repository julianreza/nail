import LoginForm from "./login-form";
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
          <span className="login-access-tag">Workspace pribadi</span>
        </div>

        <section className="login-card" aria-labelledby="login-title">
          <header className="login-intro">
            <p className="eyebrow">AREA OWNER</p>
            <h1 className="login-title" id="login-title">Masuk ke workspace</h1>
            <p className="login-description">
              Satu tempat untuk proyek, agent, dan approval kamu.
            </p>
          </header>
          <div className="login-body">
            <LoginForm />
            <p className="login-access-note">
              Akses hanya untuk owner. Pendaftaran publik tidak tersedia.
            </p>
          </div>
        </section>
        <p className="login-caption">Workspace kamu. Tetap dalam kendalimu.</p>
      </div>
    </main>
  );
}
