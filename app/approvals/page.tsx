import SectionView from "../section-view";
import WorkspaceFrame from "../workspace-frame";

export const instant = false;

export default function ApprovalsPage() {
  return (
    <WorkspaceFrame>
      <SectionView kind="approvals" />
    </WorkspaceFrame>
  );
}
