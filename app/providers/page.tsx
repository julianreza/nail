import SectionView from "../section-view";
import WorkspaceFrame from "../workspace-frame";

export const instant = false;

export default function ProvidersPage() {
  return (
    <WorkspaceFrame>
      <SectionView kind="providers" />
    </WorkspaceFrame>
  );
}
