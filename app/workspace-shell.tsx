"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import LogoutButton from "./logout-button";
import WorkspaceIcon from "./workspace-icon";
import MascotIllustration from "./mascot-illustration";

const primaryLinks = [
  { href: "/", label: "Ringkasan", icon: "overview" },
  { href: "/projects", label: "Projects", icon: "projects" },
  { href: "/agents", label: "Agents", icon: "agents" },
  { href: "/tasks", label: "Tasks", icon: "tasks" },
  { href: "/approvals", label: "Approvals", icon: "approvals" },
  { href: "/providers", label: "Providers", icon: "providers" },
] as const;

export default function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const currentPage = primaryLinks.find((link) => link.href === pathname)?.label
    ?? (pathname.startsWith("/projects/") ? "Project detail" : "Pengaturan");

  return (
    <div className="workspace-layout">
      <aside className={`workspace-sidebar${sidebarOpen ? " is-open" : ""}`} id="workspace-navigation">
        <button
          aria-label="Tutup navigasi"
          className="workspace-sidebar-close"
          onClick={() => setSidebarOpen(false)}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
        <Link className="workspace-brand" href="/" aria-label="Nail — ringkasan">
          <span className="workspace-brand-mark mascot-brand-mark" data-mascot-brand aria-hidden="true">
            <MascotIllustration />
          </span>
          <span>
            <strong>Nail</strong>
            <small>Agent workspace</small>
          </span>
        </Link>

        <nav aria-label="Navigasi utama" className="workspace-nav">
          <p className="workspace-nav-label">WORKSPACE</p>
          {primaryLinks.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={`workspace-nav-link${active ? " is-active" : ""}`}
                href={link.href}
                key={link.href}
                onClick={() => setSidebarOpen(false)}
              >
                <span aria-hidden="true" className={`workspace-nav-mark icon-${link.icon}`}>
                  <WorkspaceIcon name={link.icon} />
                </span>
                <span>{link.label}</span>
              </Link>
            );
          })}
        </nav>

        <nav aria-label="Pengaturan" className="workspace-secondary-nav">
          <Link
            aria-current={pathname === "/settings" ? "page" : undefined}
            className={`workspace-nav-link${pathname === "/settings" ? " is-active" : ""}`}
            href="/settings"
            onClick={() => setSidebarOpen(false)}
          >
            <span aria-hidden="true" className="workspace-nav-mark icon-settings"><WorkspaceIcon name="settings" /></span>
            <span>Pengaturan</span>
          </Link>
        </nav>

        <div className="workspace-sidebar-footer">
          <span className="owner-status-dot" aria-hidden="true" />
          <span>Owner aktif</span>
        </div>
      </aside>

      <div className="workspace-main-column">
        <header className="workspace-topbar">
          <div className="workspace-topbar-context">
            <button
              aria-controls="workspace-navigation"
              aria-expanded={sidebarOpen}
              aria-label={sidebarOpen ? "Sembunyikan navigasi" : "Tampilkan navigasi"}
              className="workspace-menu-toggle"
              onClick={() => setSidebarOpen((open) => !open)}
              type="button"
            >
              <span aria-hidden="true">☰</span>
            </button>
            <span className="topbar-owner-badge"><span aria-hidden="true" /> OWNER</span>
            <p aria-label="Halaman aktif">{currentPage}</p>
            <span className="topbar-caption">Workspace pribadi, kendali penuh.</span>
          </div>
          <LogoutButton />
        </header>
        <main className="workspace-content">{children}</main>
      </div>
    </div>
  );
}
