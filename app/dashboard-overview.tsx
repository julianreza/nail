"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AgentSummary } from "../lib/domain/agent";
import WorkspaceIcon from "./workspace-icon";
import MascotIllustration from "./mascot-illustration";
import DashboardAgentStudio from "./dashboard-agent-studio";
import DashboardOperations from "./dashboard-operations";

export interface OverviewPayload {
  projectsCount: number;
  agentsCount: number;
  agents: AgentSummary[];
  activeRunsCount: number;
  queuedRunsCount: number;
  pendingApprovalsCount: number;
}

function isAgentSummary(value: unknown): value is AgentSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.id === "string" && typeof summary.name === "string" && typeof summary.role === "string" &&
    (summary.projectId === null || typeof summary.projectId === "string") &&
    (summary.providerId === null || typeof summary.providerId === "string") &&
    (summary.providerName === null || typeof summary.providerName === "string") &&
    (summary.providerStatus === null || typeof summary.providerStatus === "string") &&
    (summary.model === null || typeof summary.model === "string") &&
    typeof summary.modelMatchesProvider === "boolean" &&
    Array.isArray(summary.skillIds) && summary.skillIds.every((id) => typeof id === "string");
}

function isOverviewPayload(value: unknown): value is OverviewPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.agents) || !payload.agents.every(isAgentSummary) || payload.agentsCount !== payload.agents.length) return false;
  return ["projectsCount", "agentsCount", "activeRunsCount", "queuedRunsCount", "pendingApprovalsCount"].every((key) => {
    const count = payload[key];
    return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
  });
}

const cards = [
  { key: "activeRunsCount", label: "Sedang berjalan", tone: "lime", icon: "tasks" },
  { key: "queuedRunsCount", label: "Dalam antrean", tone: "lavender", icon: "projects" },
  { key: "pendingApprovalsCount", label: "Menunggu persetujuan", tone: "peach", icon: "approvals" },
  { key: "projectsCount", label: "Projects", tone: "white", icon: "projects" },
] as const;

export function DashboardSummary({ overview }: { overview: OverviewPayload }) {
  return (
    <>
      <section aria-label="Status workspace" className="workspace-hero">
        <div className="workspace-hero-art" aria-hidden="true">
          <span className="hero-sticker">Your next big thing.</span>
          <span className="hero-emblem" data-dashboard-mascot>
            <MascotIllustration />
            <span>NAIL WORKSPACE</span>
          </span>
          <span className="hero-art-caption">IDE → PROJECT → PROGRESS</span>
        </div>
        <div className="workspace-hero-copy">
          <p className="eyebrow">WORKSPACE / OVERVIEW</p>
          <h3>Ide besar.<br />Langkah <span>terarah.</span></h3>
          <div className="hero-totals">
            <span>{overview.projectsCount} project</span>
            <span>{overview.agentsCount} agent</span>
          </div>
          <p>Atur proyek, pantau run, dan tinjau keputusan penting dari satu tempat.</p>
          <Link href="/projects" className="button-primary hero-project-link">Buka projects <span aria-hidden="true">↗</span></Link>
        </div>
      </section>
      <div className="summary-section-title"><h3>Workspace dalam angka</h3><span>Jumlah tersimpan, bukan data contoh.</span></div>
      <div className="dashboard-card-grid">
        {cards.map((card) => (
          <article className={`dashboard-stat-card tone-${card.tone}`} key={card.key}>
            <span className="stat-card-icon"><WorkspaceIcon name={card.icon} /></span>
            <span className="stat-card-label">{card.label}</span>
            <strong className="stat-card-value">
              {new Intl.NumberFormat("id-ID").format(overview[card.key])}
            </strong>
          </article>
        ))}
      </div>
      <div className="dashboard-command-grid">
        <DashboardAgentStudio agents={overview.agents} />
        <DashboardOperations overview={overview} />
      </div>
      <section className="dashboard-empty-panel">
        <div aria-hidden="true" className="empty-illustration"><MascotIllustration /></div>
        <div>
          <p className="eyebrow">LANGKAH BERIKUTNYA</p>
          <h3>{overview.projectsCount === 0 ? "Mulai dari sebuah project" : "Workspace siap dipakai"}</h3>
          <p>
            {overview.projectsCount === 0
              ? "Belum ada project tersimpan. Setelah project dibuat, status run, antrean, dan persetujuan akan muncul di sini."
              : "Ringkasan ini hanya menampilkan jumlah yang tersimpan di database; belum ada aktivitas contoh."}
          </p>
        </div>
      </section>
    </>
  );
}

export default function DashboardOverview() {
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;

    fetch("/api/overview", { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message =
            typeof body === "object" && body !== null && "error" in body &&
            typeof body.error === "string"
              ? body.error
              : "Data tidak dapat dimuat.";
          throw new Error(message);
        }
        if (!isOverviewPayload(body)) throw new Error("Format ringkasan tidak valid.");
        if (active) setOverview(body);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Data tidak dapat dimuat.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [retry]);

  return (
    <section aria-label="Ringkasan workspace" className="dashboard-content">
      <div className="dashboard-section-heading">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h2>Ringkasan <span>workspace</span></h2>
        </div>
        <span className="dashboard-snapshot-label">Ringkasan tersimpan</span>
      </div>

      {loading ? (
        <div aria-label="Memuat ringkasan" aria-live="polite" className="dashboard-card-grid">
          {cards.map((card) => (
            <div className="dashboard-stat-card is-loading" key={card.key}>
              <span className="stat-card-label">{card.label}</span>
              <span className="loading-bar" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div aria-live="polite" className="state-card state-card-error" role="alert">
          <div>
            <h3>Ringkasan belum tersedia</h3>
            <p>{error}</p>
            {error === "Database is not configured" ? (
              <p className="setup-hint">
                Set <code>DATABASE_URL</code> server ke koneksi PostgreSQL Supabase untuk memuat data.
              </p>
            ) : null}
          </div>
          <button
            className="button-secondary"
            onClick={() => {
              setLoading(true);
              setError(null);
              setRetry((value) => value + 1);
            }}
            type="button"
          >
            Coba lagi
          </button>
        </div>
      ) : overview ? (
        <DashboardSummary overview={overview} />
      ) : null}
    </section>
  );
}
