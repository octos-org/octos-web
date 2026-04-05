import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback } from "react";
import { SlidesProvider, useSlides } from "../context/slides-context";
import { SlidesEditorLayout } from "../layouts/slides-editor-layout";
import SlidePreview from "../components/slide-preview";
import { SlidesChat } from "../components/slides-chat";
import { getSlidesProject } from "../store";

function SlidesEditorContent() {
  const { project } = useSlides();
  const [currentIndex, setCurrentIndex] = useState(0);
  const navigate = useNavigate();

  // Clamp index when slides change
  useEffect(() => {
    if (project && currentIndex >= project.slides.length && project.slides.length > 0) {
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

  // Esc key → back to gallery
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        navigate("/slides");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate]);

  return (
    <SlidesEditorLayout
      previewPanel={
        <SlidePreview
          slides={project?.slides ?? []}
          currentIndex={currentIndex}
          onIndexChange={setCurrentIndex}
          pptxUrl={project?.pptxUrl}
          onPresent={handlePresent}
        />
      }
      chatPanel={
        project ? (
          <SlidesChat sessionId={project.chatSessionId} />
        ) : undefined
      }
    />
  );
}

export function SlidesEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const project = id ? getSlidesProject(id) : undefined;

  useEffect(() => {
    if (id && !project) {
      navigate("/slides", { replace: true });
    }
  }, [id, project, navigate]);

  if (!id || !project) return null;

  return (
    <SlidesProvider projectId={id}>
      <SlidesEditorContent />
    </SlidesProvider>
  );
}
