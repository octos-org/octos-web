import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback } from "react";
import { getMyProfileStatus } from "@/settings/settings-api";

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
import type { SlidesProject } from "../types";

function shouldHydrateProject(project: SlidesProject | undefined): boolean {
  if (!project) return true;
  if (!project.scaffolded) return false;
  if (!project.slug) return true;
  return project.slides.length === 0 || !project.pptxUrl;
}

function SlidesEditorContent() {
  const { project, save, updateSlide, removeSlide, moveSlide, editError, savingEdits, renderingEdits, retryEdits } = useSlides();
  const pendingEdits = Boolean(project?.manualEdits && project.appliedEditRevision !== project.manualEdits.revision);
  const [currentIndex, setCurrentIndex] = useState(0);
  // Codex round-3 BLOCK D.b: bumped by the editor layout's retry
  // affordance after a scaffold failure. SlidesChat watches this in
  // its auto-scaffold effect deps, which re-runs the scaffold turn.
  const [retryNonce, setRetryNonce] = useState(0);
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

  const handleRetryScaffold = useCallback(() => {
    save({ scaffoldError: undefined });
    setRetryNonce((value) => value + 1);
  }, [save]);

  // Removed: Esc was navigating to gallery even when image viewer was open

  return (
    <SlidesEditorLayout
      onRetryScaffold={handleRetryScaffold}
      previewPanel={
        <div className="flex h-full min-h-0 flex-col">
          {editError && <p role="alert" className="px-4 py-2 text-sm text-red-400">{editError}</p>}
          {(pendingEdits || savingEdits) && (
            <div className="flex items-center gap-3 px-4 py-2 text-sm" role="status">
              <span>{savingEdits ? "Saving edits…" : renderingEdits ? "Edits saved. Regenerating the presentation…" : "Edits saved. Waiting for updated previews and PPTX."}</span>
              {pendingEdits && <button type="button" className="underline" disabled={savingEdits || renderingEdits} onClick={retryEdits}>Retry regeneration</button>}
            </div>
          )}
        <SlidePreview
          slides={pendingEdits ? (project?.slides ?? []).map((slide) => ({ ...slide, thumbnailUrl: undefined })) : project?.slides ?? []}
          currentIndex={currentIndex}
          onIndexChange={setCurrentIndex}
          pptxUrl={pendingEdits ? undefined : project?.pptxUrl}
          onPresent={pendingEdits ? undefined : handlePresent}
          version={project?.manifestGeneratedAt}
          // Manual edit (2026-08 audit #320): wire the context-backed
          // slide CRUD that previously had no UI consumers.
          onUpdate={updateSlide}
          onRemove={savingEdits ? undefined : removeSlide}
          onMove={savingEdits ? undefined : moveSlide}
        />
        </div>
      }
      chatPanel={
        project ? (
          <SlidesChat sessionId={project.id} retryNonce={retryNonce} />
        ) : undefined
      }
    />
  );
}

export function SlidesEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState<string | null>(null);
  const navigate = useNavigate();

  const project = id ? getSlidesProject(id) : undefined;
  const needsHydration = shouldHydrateProject(project);

  useEffect(() => {
    if (!id || !needsHydration) return;
    const sessionId = id;

    let stopped = false;
    setHydrating(true);
    setHydrateError(null);

    async function hydrate() {
      try {
        const profileStatus = await getMyProfileStatus();
        if (stopped) return;
        if (profileStatus?.running === false) {
          if (!project) {
            setHydrateError(
              "Local runtime is stopped. Start this profile from Settings > Server to load this deck.",
            );
          }
          return;
        }
        const nextProject = await hydrateSlidesProjectFromSession(sessionId);
        if (stopped) return;

        if (!nextProject) {
          if (project) return;
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
  }, [id, navigate, needsHydration, project]);

  if (!id) return null;

  if (!project) {
    return (
      <div className="workbench-shell flex min-h-screen items-center justify-center px-6 text-center">
        <div className="workbench-panel max-w-md p-6">
          <div className="text-sm font-semibold uppercase text-muted">
            Slides Workspace
          </div>
          <div className="mt-4 text-base text-text-strong">
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
