import type { ReactNode } from "react";
import { requireOwnerPage } from "@/lib/server/auth/require-owner-page";
import WorkspaceShell from "./workspace-shell";

export default async function WorkspaceFrame({
  children,
}: {
  children: ReactNode;
}) {
  await requireOwnerPage();
  return <WorkspaceShell>{children}</WorkspaceShell>;
}
