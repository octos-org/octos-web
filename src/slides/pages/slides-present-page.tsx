import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Pause,
  Play,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

import { SlidesProvider, useSlides } from "../context/slides-context";
import { getSlidesProject } from "../store";
import { useAuthenticatedFileUrl } from "../components/authenticated-file-image";
import { SLIDE_ASPECT_RATIO } from "../constants";

const AUTOPLAY_MS = 3000;

function SlidesPresentContent() {
  const { project } = useSlides();
  const navigate = useNavigate();
  const location = useLocation();
  const generatedSlides = useMemo(
    () => (project?.slides ?? []).filter((slide) => !!slide.thumbnailUrl),
    [project?.slides],
  );
  const initialIndex =
    typeof location.state === "object" &&
    location.state &&
    "index" in location.state &&
    typeof location.state.index === "number"
      ? location.state.index
      : 0;
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isPlaying, setIsPlaying] = useState(true);

  useEffect(() => {
    setCurrentIndex((value: number) =>
      generatedSlides.length === 0
        ? 0
        : Math.min(value, generatedSlides.length - 1),
    );
  }, [generatedSlides.length]);

  useEffect(() => {
    if (!isPlaying || generatedSlides.length <= 1) return;
    const id = window.setInterval(() => {
      setCurrentIndex((value: number) => {
        if (value >= generatedSlides.length - 1) {
          window.clearInterval(id);
          setIsPlaying(false);
          return value;
        }
        return value + 1;
      });
    }, AUTOPLAY_MS);
    return () => window.clearInterval(id);
  }, [generatedSlides.length, isPlaying]);

  const goBack = useCallback(() => {
    if (project) {
      navigate(`/slides/${project.id}`);
    } else {
      navigate("/slides");
    }
  }, [navigate, project]);

  const goPrev = useCallback(() => {
    setIsPlaying(false);
    setCurrentIndex((value: number) => Math.max(0, value - 1));
  }, []);

  const goNext = useCallback(() => {
    setIsPlaying(false);
    setCurrentIndex((value: number) =>
      Math.min(generatedSlides.length - 1, value + 1),
    );
  }, [generatedSlides.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        goBack();
        return;
      }
      if (event.key === "ArrowLeft") {
        goPrev();
        return;
      }
      if (event.key === "ArrowRight") {
        goNext();
        return;
      }
      if (event.key === " " || event.key === "k") {
        event.preventDefault();
        setIsPlaying((value) => !value);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBack, goNext, goPrev]);

  const currentSlide = generatedSlides[currentIndex];
  const currentImageUrl = useAuthenticatedFileUrl(currentSlide?.thumbnailUrl, project?.manifestGeneratedAt);

  if (!project) return null;

  if (generatedSlides.length === 0) {
    return (
      <div className="flex h-screen flex-col bg-black text-white">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <button
            onClick={goBack}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft size={16} />
            Back
          </button>
          <div className="text-sm text-white/60">{project.title}</div>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-white/70">
          No generated PNG slides yet. Generate the deck first, then play it here.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-black text-white">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={goBack}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white"
          >
            <ArrowLeft size={16} />
            Back
          </button>
          <button
            onClick={() => setIsPlaying((value) => !value)}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white"
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            {isPlaying ? "Pause" : "Play"}
          </button>
        </div>
        <div className="text-sm text-white/60">
          {project.title} · {currentIndex + 1} / {generatedSlides.length}
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center p-6">
        <div
          className="relative w-full overflow-hidden rounded-2xl bg-black shadow-2xl"
          style={{ maxHeight: "100%", aspectRatio: `${SLIDE_ASPECT_RATIO}` }}
        >
          {currentImageUrl ? (
            <img
              src={currentImageUrl}
              alt={currentSlide.title || `Slide ${currentIndex + 1}`}
              className="h-full w-full object-contain"
              draggable={false}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-white/60">
              Loading slide...
            </div>
          )}

          {currentIndex > 0 && (
            <button
              onClick={goPrev}
              className="absolute left-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/75"
              title="Previous slide"
            >
              <ChevronLeft size={22} />
            </button>
          )}

          {currentIndex < generatedSlides.length - 1 && (
            <button
              onClick={goNext}
              className="absolute right-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/75"
              title="Next slide"
            >
              <ChevronRight size={22} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function SlidesPresentPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const project = id ? getSlidesProject(id) : undefined;

  useEffect(() => {
    if (id && !project) {
      navigate("/slides", { replace: true });
    }
  }, [id, navigate, project]);

  if (!id || !project) return null;

  return (
    <SlidesProvider projectId={id}>
      <SlidesPresentContent />
    </SlidesProvider>
  );
}
