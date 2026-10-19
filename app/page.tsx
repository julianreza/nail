import DashboardOverview from "./dashboard-overview";
import WorkspaceFrame from "./workspace-frame";

export const instant = false;

export default function Home() {
  return (
    <WorkspaceFrame>
      <DashboardOverview />
    </WorkspaceFrame>
  );
}
