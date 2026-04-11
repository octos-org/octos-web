import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { getSelectedProfileId } from "@/api/client";

import { hydrateSiteProjectFromSession } from "../api";
import { SitesChat } from "../components/sites-chat";
import { SitePreview } from "../components/site-preview";
import { SitesProvider, useSites } from "../context/sites-context";
import { SitesEditorLayout } from "../layouts/sites-editor-layout";
import { getSiteProject, upsertSiteProject } from "../store";

function SitesEditorContent() {
  const { project } = useSites();

  return (
    <SitesEditorLayout
      previewPanel={
        <SitePreview
          previewUrl={project?.previewUrl}
          siteName={project?.title || "Untitled Site"}
          template={project?.template || "site"}
          sessionId={project?.id}
          scaffoldError={project?.scaffoldError}
        />
      }
      chatPanel={
        project ? <SitesChat sessionId={project.id} /> : undefined
      }
    />
  );
}

export function SitesEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const project = id ? getSiteProject(id) : undefined;

  useEffect(() => {
    if (!id || project) return;
    const sessionId = id;

    let stopped = false;
    setHydrating(true);
    setHydrateError(null);

    async function hydrate() {
      try {
        const profileId = getSelectedProfileId();
        const nextProject = await hydrateSiteProjectFromSession(
          sessionId!,
          profileId,
        );
        if (stopped) return;

        if (nextProject) {
          upsertSiteProject(nextProject);
          return;
        }
        setHydrateError("Site session unavailable.");
      } catch (error) {
        if (stopped) return;
        setHydrateError(
          error instanceof Error
            ? error.message
            : "Failed to load site session.",
        );
      } finally {
        if (!stopped) setHydrating(false);
      }
    }

    void hydrate();

    return () => {
      stopped = true;
    };
  }, [id, project]);

  if (!id) return null;

  if (!project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-dark px-6 text-center">
        <div className="max-w-md rounded-2xl border border-border bg-surface p-6">
          <div className="text-sm font-semibold uppercase tracking-[0.18em] text-muted">
            Site Studio
          </div>
          <div className="mt-4 text-base text-white">
            {hydrating ? "Loading site session..." : "Site session unavailable"}
          </div>
          <div className="mt-3 text-sm leading-6 text-muted">
            {hydrateError ||
              "Octos loads site sessions only from scaffolded backend workspace metadata."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <SitesProvider projectId={project.id}>
      <SitesEditorContent />
    </SitesProvider>
  );
}
