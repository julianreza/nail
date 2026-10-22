import WorkspaceFrame from "../workspace-frame";
import AgentManager from "./agent-manager";

export const instant = false;

export default function AgentsPage() {
  return (
    <WorkspaceFrame>
      <AgentManager />
    </WorkspaceFrame>
  );
}
