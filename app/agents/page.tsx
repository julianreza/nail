import SectionView from "../section-view";
import WorkspaceFrame from "../workspace-frame";

export const instant = false;

export default function AgentsPage() {
  return (
    <WorkspaceFrame>
      <SectionView kind="agents" />
    </WorkspaceFrame>
  );
}
