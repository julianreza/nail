import ProviderSetupForm from "../provider-setup-form";
import SectionView from "../section-view";
import WorkspaceFrame from "../workspace-frame";

export const instant = false;

export default function ProvidersPage() {
  return (
    <WorkspaceFrame>
      <div className="section-page">
        <ProviderSetupForm />
        <SectionView kind="providers" />
      </div>
    </WorkspaceFrame>
  );
}
