import ProjectRunView from "../../project-run-view";
import WorkspaceFrame from "../../workspace-frame";

export const instant = false;

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <WorkspaceFrame>
      <ProjectRunView projectId={projectId} />
    </WorkspaceFrame>
  );
}
