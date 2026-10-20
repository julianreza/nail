"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import LogoutButton from "./logout-button";
import WorkspaceIcon from "./workspace-icon";

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
  const currentPage = primaryLinks.find((link) => link.href === pathname)?.label
    ?? (pathname.startsWith("/projects/") ? "Project detail" : "Pengaturan");

  return (
    <div className="workspace-layout">
      <aside className="workspace-sidebar">
        <Link className="workspace-brand" href="/" aria-label="Nail — ringkasan">
          <span className="workspace-brand-mark" aria-hidden="true">N</span>
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
