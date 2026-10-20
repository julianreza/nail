import ProviderSetupForm from "../provider-setup-form";
import SubscriptionProviderPanel from "../subscription-provider-panel";
import SectionView from "../section-view";
import WorkspaceFrame from "../workspace-frame";

export const instant = false;

export default function ProvidersPage() {
  return (
    <WorkspaceFrame>
      <div className="section-page">
        <ProviderSetupForm />
        <SubscriptionProviderPanel />
        <SectionView kind="providers" />
      </div>
    </WorkspaceFrame>
  );
}
