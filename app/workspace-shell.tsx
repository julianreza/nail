"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import LogoutButton from "./logout-button";

const primaryLinks = [
  { href: "/", label: "Ringkasan", mark: "R" },
  { href: "/projects", label: "Projects", mark: "P" },
  { href: "/agents", label: "Agents", mark: "A" },
  { href: "/tasks", label: "Tasks", mark: "T" },
  { href: "/approvals", label: "Approvals", mark: "✓" },
  { href: "/providers", label: "Providers", mark: "◎" },
];

export default function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

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
                <span aria-hidden="true" className="workspace-nav-mark">
                  {link.mark}
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
            <span aria-hidden="true" className="workspace-nav-mark">⚙</span>
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
          <p>Workspace pribadi</p>
          <LogoutButton />
        </header>
        <main className="workspace-content">{children}</main>
      </div>
    </div>
  );
}
