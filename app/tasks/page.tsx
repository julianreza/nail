import SectionView from "../section-view";
import WorkspaceFrame from "../workspace-frame";

export const instant = false;

export default function TasksPage() {
  return (
    <WorkspaceFrame>
      <SectionView kind="tasks" />
    </WorkspaceFrame>
  );
}
