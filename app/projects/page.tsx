import SectionView from "../section-view";
import WorkspaceFrame from "../workspace-frame";

export const instant = false;

export default function ProjectsPage() {
  return (
    <WorkspaceFrame>
      <SectionView kind="projects" />
    </WorkspaceFrame>
  );
}
