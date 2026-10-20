"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SectionKind = "projects" | "agents" | "tasks" | "approvals" | "providers";
type RecordItem = Record<string, unknown>;

interface SectionConfig {
  title: string;
  eyebrow: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
}

const sectionConfig: Record<SectionKind, SectionConfig> = {
  projects: {
    title: "Projects",
    eyebrow: "WORKSPACE",
    description: "Project yang tersimpan di database Nail.",
    emptyTitle: "Belum ada project",
    emptyDescription: "Project akan muncul di sini setelah dibuat melalui alur setup.",
  },
  agents: {
    title: "Agents",
    eyebrow: "TIM ANDA",
    description: "Peran agent yang tersedia di workspace.",
    emptyTitle: "Belum ada agent",
    emptyDescription: "Agent yang tersimpan akan tampil di sini; tidak ada data contoh.",
  },
  tasks: {
    title: "Tasks",
    eyebrow: "EKSEKUSI",
    description: "Tugas dari run yang tersimpan.",
    emptyTitle: "Belum ada task",
    emptyDescription: "Task akan muncul setelah sebuah run dibuat.",
  },
  approvals: {
    title: "Approvals",
    eyebrow: "PERLU TINDAKAN",
    description: "Keputusan approval yang tersimpan.",
    emptyTitle: "Tidak ada approval",
    emptyDescription: "Approval yang menunggu atau sudah diputuskan akan tampil di sini.",
  },
  providers: {
    title: "Providers",
    eyebrow: "KONEKSI AI",
    description: "Status dan kemampuan provider tanpa menampilkan referensi secret.",
    emptyTitle: "Belum ada provider",
    emptyDescription: "Provider belum dikonfigurasi. Secret tidak pernah ditampilkan pada daftar ini.",
  },
};

function isRecordList(value: unknown): value is RecordItem[] {
  return Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null);
}

function itemTitle(kind: SectionKind, item: RecordItem): string {
  const titleKey = kind === "tasks" ? "title" : "name";
  const title = item[titleKey];
  if (typeof title === "string" && title.length > 0) return title;
  return typeof item.id === "string" ? item.id : "Item tanpa nama";
}

function itemDetail(kind: SectionKind, item: RecordItem): string {
  switch (kind) {
    case "projects":
      return typeof item.repoUrl === "string" ? item.repoUrl : "Repository belum ditautkan";
    case "agents":
      return typeof item.role === "string" ? item.role : "Peran belum ditentukan";
    case "tasks":
      return typeof item.state === "string" ? item.state : "Status belum tersedia";
    case "approvals":
      return typeof item.decision === "string" ? item.decision : "Status belum tersedia";
    case "providers":
      return [item.status, item.model, item.authMode]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" · ") || "Status belum tersedia";
  }
}

export function SectionEmptyState({ kind }: { kind: SectionKind }) {
  const config = sectionConfig[kind];
  return (
    <div className="state-card section-empty-state">
      <span aria-hidden="true" className="empty-illustration">
        {config.title.slice(0, 1)}
      </span>
      <div>
        <h3>{config.emptyTitle}</h3>
        <p>{config.emptyDescription}</p>
      </div>
    </div>
  );
}

export default function SectionView({ kind }: { kind: SectionKind }) {
  const config = sectionConfig[kind];
  const [items, setItems] = useState<RecordItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;

    fetch(`/api/${kind}`, { cache: "no-store" })
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
        if (!isRecordList(body)) throw new Error("Format data tidak valid.");
        if (active) setItems(body);
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
  }, [kind, retry]);

  return (
    <section aria-label={config.title} className="section-page">
      <div className="dashboard-section-heading">
        <div>
          <p className="eyebrow">{config.eyebrow}</p>
          <h2>{config.title}</h2>
          <p className="page-description">{config.description}</p>
        </div>
      </div>

      {loading ? (
        <div aria-label={`Memuat ${config.title}`} aria-live="polite" className="state-card">
          <span className="loading-bar" />
          <p>Memuat data…</p>
        </div>
      ) : error ? (
        <div aria-live="polite" className="state-card state-card-error" role="alert">
          <div>
            <h3>Data belum tersedia</h3>
            <p>{error}</p>
            {error === "Database is not configured" ? (
              <p className="setup-hint">
                Set <code>NAIL_DATABASE_PATH</code> ke lokasi SQLite persisten.
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
      ) : items?.length === 0 ? (
        <SectionEmptyState kind={kind} />
      ) : (
        <ul className="record-list">
          {items?.map((item, index) => {
            const record = (
              <>
                <span aria-hidden="true" className="record-mark">{config.title.slice(0, 1)}</span>
                <span className="record-copy">
                  <strong>{itemTitle(kind, item)}</strong>
                  <span>{itemDetail(kind, item)}</span>
                </span>
              </>
            );
            const key = typeof item.id === "string" ? item.id : index;
            return (
              <li key={key}>
                {kind === "projects" && typeof item.id === "string" ? (
                  <Link className="record-card record-card-link" href={`/projects/${encodeURIComponent(item.id)}`}>
                    {record}
                  </Link>
                ) : (
                  <div className="record-card">{record}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
