import { useParams, useNavigate } from "react-router-dom";
import { useEffect, useMemo } from "react";
import { StudioProvider } from "@/studio/context/studio-context";
import { StudioLayout } from "@/studio/layouts/studio-layout";
import { getProject, createProject } from "@/studio/store";

export function StudioPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  // For /studio/new, create a project and redirect
  useEffect(() => {
    if (!projectId) {
      const project = createProject({ title: "Untitled project" });
      navigate(`/studio/${project.id}`, { replace: true });
    }
  }, [projectId, navigate]);

  // Verify project exists
  const project = projectId ? getProject(projectId) : undefined;
  useEffect(() => {
    if (projectId && !project) {
      navigate("/", { replace: true });
    }
  }, [projectId, project, navigate]);

  if (!projectId || !project) {
    return null;
  }

  return (
    <StudioProvider projectId={projectId}>
      <StudioLayout />
    </StudioProvider>
  );
}
