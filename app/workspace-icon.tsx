export type WorkspaceIconName = "overview" | "projects" | "agents" | "tasks" | "approvals" | "providers" | "settings";

const paths: Record<WorkspaceIconName, string> = {
  overview: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  projects: "M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
  agents: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m9-7.87a4 4 0 0 1 0 7.75",
  tasks: "M9 5h12M9 12h12M9 19h12M3 5l1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2",
  approvals: "M12 3 3 7v6c0 5 9 9 9 9s9-4 9-9V7l-9-4ZM8 12l3 3 5-6",
  providers: "M9 3v5m6-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v4",
  settings: "m12 3 2 3 3-1 2 3-2 3 2 3-2 3-3-1-2 3-2-3-3 1-2-3 2-3-2-3 2-3 3 1 2-3Zm0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
};

export default function WorkspaceIcon({ name }: { name: WorkspaceIconName }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d={paths[name]} />
    </svg>
  );
}
