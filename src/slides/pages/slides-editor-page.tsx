import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback } from "react";
import { SlidesProvider, useSlides } from "../context/slides-context";
import { SlidesEditorLayout } from "../layouts/slides-editor-layout";
import SlidePreview from "../components/slide-preview";
import { SlidesChat } from "../components/slides-chat";
import { hydrateSlidesProjectFromSession } from "../api";
import {
  deleteSlidesProject,
  getSlidesProject,
  upsertSlidesProject,
} from "../store";

function SlidesEditorContent() {
  const { project } = useSlides();
  const [currentIndex, setCurrentIndex] = useState(0);
  const navigate = useNavigate();

  // Clamp index when slides change
  useEffect(() => {
    if (
      project &&
      currentIndex >= project.slides.length &&
      project.slides.length > 0
    ) {
      setCurrentIndex(project.slides.length - 1);
    }
  }, [project, currentIndex]);

  const handlePresent = useCallback(() => {
    if (project) {
      navigate(`/slides/${project.id}/present`, {
        state: { index: currentIndex },
      });
    }
  }, [currentIndex, navigate, project]);

  // Removed: Esc was navigating to gallery even when image viewer was open

  return (
    <SlidesEditorLayout
      previewPanel={
        <SlidePreview
          slides={project?.slides ?? []}
          currentIndex={currentIndex}
          onIndexChange={setCurrentIndex}
          pptxUrl={project?.pptxUrl}
          onPresent={handlePresent}
          version={project?.manifestGeneratedAt}
        />
      }
      chatPanel={project ? <SlidesChat sessionId={project.id} /> : undefined}
    />
  );
}

export function SlidesEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const navigate = useNavigate();

  const project = id ? getSlidesProject(id) : undefined;

  useEffect(() => {
    if (!id || project) return;
    const sessionId = id;

    let stopped = false;
    setHydrating(true);
    setHydrateError(null);

    async function hydrate() {
      try {
        const nextProject = await hydrateSlidesProjectFromSession(sessionId);
        if (stopped) return;

        if (!nextProject) {
          setHydrateError("Slides session unavailable.");
          return;
        }

        upsertSlidesProject(nextProject);
        if (nextProject.id !== sessionId) {
          deleteSlidesProject(sessionId);
          navigate(`/slides/${nextProject.id}`, { replace: true });
        }
      } catch (error) {
        if (stopped) return;
        setHydrateError(
          error instanceof Error
            ? error.message
            : "Failed to load slides session.",
        );
      } finally {
        if (!stopped) setHydrating(false);
      }
    }

    void hydrate();

    return () => {
      stopped = true;
    };
  }, [id, navigate, project]);

  if (!id) return null;

  if (!project) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-dark px-6 text-center">
        <div className="max-w-md rounded-2xl border border-border bg-surface p-6">
          <div className="text-sm font-semibold uppercase tracking-[0.18em] text-muted">
            Slides Workspace
          </div>
          <div className="mt-4 text-base text-white">
            {hydrating
              ? "Loading slides session..."
              : "Slides session unavailable"}
          </div>
          <div className="mt-3 text-sm leading-6 text-muted">
            {hydrateError ||
              "Octos is reconstructing this deck from the backend session workspace."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <SlidesProvider projectId={project.id}>
      <SlidesEditorContent />
    </SlidesProvider>
  );
}
