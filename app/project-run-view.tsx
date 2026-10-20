"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface ApprovalDetail {
  id: string;
  decision: "pending" | "approved" | "rejected";
  payloadFingerprint: string;
  planVersion: number;
  baselineCommit: string | null;
  scope: {
    setupCommands: string[];
    verificationCommands: string[];
    permissions: string[];
    costLimitMicrounits: number;
  };
}

interface ProjectRun {
  id: string;
  state: string;
  planVersion: number;
  baselineCommit: string | null;
  plan: {
    goal: string;
    acceptanceCriteria: Array<{ id: string; description: string }>;
    setupCommands: string[];
    verificationCommands: string[];
    allowedTools: string[];
    approvalFingerprint: string;
  } | null;
  tasks: Array<{
    id: string;
    title: string;
    state: string;
    ownerAgentId: string | null;
    dependsOn: string[];
  }>;
  approvals: ApprovalDetail[];
  qaRounds: Array<{ roundNumber: number; status: string; details: string }>;
}

interface ProjectRunResponse {
  project: { id: string; name: string; repoUrl: string | null; baselineCommit: string | null };
  runs: ProjectRun[];
}

function isProjectRunResponse(value: unknown): value is ProjectRunResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.project === "object" && record.project !== null && Array.isArray(record.runs);
}

export default function ProjectRunView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ProjectRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/runs`, { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const message =
            typeof body === "object" && body !== null && "error" in body &&
            typeof body.error === "string"
              ? body.error
              : "Data project tidak dapat dimuat.";
          throw new Error(message);
        }
        if (!isProjectRunResponse(body)) throw new Error("Format data project tidak valid.");
        if (active) setData(body);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Data project tidak dapat dimuat.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, refresh]);

  async function decide(approval: ApprovalDetail, decision: "approved" | "rejected") {
    setPendingApproval(approval.id);
    setActionMessage(null);
    try {
      const response = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, expectedFingerprint: approval.payloadFingerprint }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Keputusan approval tidak tersimpan.";
        throw new Error(message);
      }
      setActionMessage(decision === "approved" ? "Rencana disetujui dan masuk antrean." : "Rencana ditolak.");
      setRefresh((value) => value + 1);
    } catch (reason) {
      setActionMessage(reason instanceof Error ? reason.message : "Keputusan approval tidak tersimpan.");
    } finally {
      setPendingApproval(null);
    }
  }

  return (
    <section className="project-run-view">
      {loading ? (
        <div aria-live="polite" className="state-card"><span className="loading-bar" /><p>Memuat project…</p></div>
      ) : error ? (
        <div aria-live="polite" className="state-card state-card-error" role="alert">
          <div><h2>Project tidak tersedia</h2><p>{error}</p></div>
          <button className="button-secondary" onClick={() => { setError(null); setLoading(true); setRefresh((value) => value + 1); }} type="button">Coba lagi</button>
        </div>
      ) : data ? (
        <>
          <div className="project-detail-heading">
            <div>
              <Link className="back-link" href="/projects">← Kembali ke Projects</Link>
              <p className="eyebrow">PROJECT DETAIL</p>
              <h2>{data.project.name}</h2>
              <p className="page-description">{data.project.repoUrl ?? "Project kosong"} · Baseline {data.project.baselineCommit ?? "belum ditetapkan"}</p>
            </div>
            <span className="project-count-badge">{data.runs.length} run</span>
          </div>

          {actionMessage ? <p aria-live="polite" className="inline-status">{actionMessage}</p> : null}
          {data.runs.length === 0 ? (
            <div className="state-card section-empty-state">
              <span aria-hidden="true" className="empty-illustration">R</span>
              <div><h3>Belum ada run</h3><p>Run akan muncul setelah rencana PM dibuat dan diajukan untuk approval.</p></div>
            </div>
          ) : (
            <div className="run-list">
              {data.runs.map((run) => (
                <article className="run-card" key={run.id}>
                  <header className="run-card-header">
                    <div><p className="eyebrow">RUN {run.id.slice(0, 8)}</p><h3>{run.plan?.goal ?? "Rencana belum tersedia"}</h3></div>
                    <span className={`run-state run-state-${run.state}`}>{run.state}</span>
                  </header>
                  {run.plan ? (
                    <>
                      <div className="run-detail-grid">
                        <section>
                          <h4>Acceptance criteria</h4>
                          <ul className="detail-list">
                            {run.plan.acceptanceCriteria.map((criterion) => <li key={criterion.id}>{criterion.description}</li>)}
                          </ul>
                        </section>
                        <section>
                          <h4>Verifikasi disetujui</h4>
                          {run.plan.verificationCommands.length > 0 ? (
                            <ul className="command-list">{run.plan.verificationCommands.map((command) => <li key={command}><code>{command}</code></li>)}</ul>
                          ) : <p className="muted-copy">Belum ada perintah verifikasi otomatis; hasil akhir perlu konfirmasi manual.</p>}
                        </section>
                      </div>
                      <section className="run-tasks">
                        <h4>Tasks · serial</h4>
                        {run.tasks.length === 0 ? <p className="muted-copy">Belum ada subtask tersimpan.</p> : (
                          <ol className="task-list">
                            {run.tasks.map((task, index) => (
                              <li key={task.id}>
                                <span className="task-number">{index + 1}</span>
                                <span className="task-copy"><strong>{task.title}</strong><small>{task.ownerAgentId ?? "Belum ditugaskan"}{task.dependsOn.length ? ` · menunggu ${task.dependsOn.length} dependency` : " · siap setelah antrean berjalan"}</small></span>
                                <span className="task-state">{task.state}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                      </section>
                      {run.approvals.filter((approval) => approval.decision === "pending").map((approval) => (
                        <section aria-label="Approval menunggu" className="approval-review-card" key={approval.id}>
                          <div>
                            <p className="eyebrow">APPROVAL · PLAN v{approval.planVersion}</p>
                            <h4>Tinjau cakupan eksekusi</h4>
                            <p>Baseline: <code>{approval.baselineCommit ?? "project kosong"}</code></p>
                            <p>Permission: {approval.scope.permissions.join(", ") || "tidak ada"}</p>
                            <p>Batas biaya: {approval.scope.costLimitMicrounits} microunits</p>
                            <ul className="command-list">
                              {[...approval.scope.setupCommands, ...approval.scope.verificationCommands].map((command, index) => <li key={`${index}-${command}`}><code>{command}</code></li>)}
                            </ul>
                            <small>Fingerprint: <code>{approval.payloadFingerprint}</code></small>
                          </div>
                          <div className="approval-actions">
                            <button className="button-primary" disabled={pendingApproval === approval.id} onClick={() => decide(approval, "approved")} type="button">Setujui & antrekan</button>
                            <button className="button-secondary" disabled={pendingApproval === approval.id} onClick={() => decide(approval, "rejected")} type="button">Tolak</button>
                          </div>
                        </section>
                      ))}
                    </>
                  ) : <p className="muted-copy">Plan belum disimpan.</p>}
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
