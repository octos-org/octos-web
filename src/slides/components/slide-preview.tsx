import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, ChevronRight, Download, Maximize2 } from "lucide-react";
import { SLIDE_ASPECT_RATIO } from "../constants";
import type { Slide } from "../types";
import { useAuthenticatedFileUrl } from "./authenticated-file-image";

interface Props {
  slides: Slide[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
  pptxUrl?: string;
  onPresent?: () => void;
  /** Changes when slide images are regenerated — forces image re-fetch */
  version?: string;
}

export default function SlidePreview({
  slides,
  currentIndex,
  onIndexChange,
  pptxUrl,
  onPresent,
  version,
}: Props) {
  const [imgError, setImgError] = useState(false);

  const current = slides[currentIndex];
  const currentImageUrl = useAuthenticatedFileUrl(current?.thumbnailUrl, version);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) onIndexChange(currentIndex - 1);
  }, [currentIndex, onIndexChange]);

  const goNext = useCallback(() => {
    if (currentIndex < slides.length - 1) onIndexChange(currentIndex + 1);
  }, [currentIndex, slides.length, onIndexChange]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") goPrev();
      if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goPrev, goNext]);

  // Reset error state on slide change
  useEffect(() => {
    setImgError(false);
  }, [currentIndex]);

  if (slides.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted">
        <div className="text-4xl mb-4">📊</div>
        <p className="text-sm">
          {pptxUrl
            ? "Deck file exists, but preview images are missing. Regenerate into slides/<slug>/output/imgs."
            : "No slides yet. Generate a deck via chat."}
        </p>
        {pptxUrl && (
          <a
            href={pptxUrl}
            download
            className="mt-3 rounded-lg bg-accent/10 px-3 py-2 text-xs font-medium text-accent hover:bg-accent/20"
          >
            Download PPTX
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Slide area */}
      <div className="flex-1 flex items-center justify-center p-4 min-h-0">
        <div
          className="relative w-full bg-black rounded-lg overflow-hidden shadow-2xl"
          style={{ maxHeight: "100%", aspectRatio: `${SLIDE_ASPECT_RATIO}` }}
        >
          {current?.thumbnailUrl && !imgError ? (
            currentImageUrl ? (
              <img
                src={currentImageUrl}
                alt={current.title || `Slide ${currentIndex + 1}`}
                className="w-full h-full object-contain"
                onError={() => setImgError(true)}
                draggable={false}
              />
            ) : (
              <div className="flex h-full items-center justify-center bg-black text-sm text-muted">
                Loading preview...
              </div>
            )
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-surface-dark to-surface p-8 text-white">
              <div className="text-xs uppercase tracking-widest text-muted mb-4">
                {current?.layout || "slide"}
              </div>
              <h2 className="text-2xl font-bold mb-3 text-center">
                {current?.title || `Slide ${currentIndex + 1}`}
              </h2>
              {current?.notes && (
                <p className="text-sm text-muted text-center max-w-md leading-relaxed">
                  {current.notes}
                </p>
              )}
              {imgError && <p className="text-xs mt-4 text-red-400">Image failed to load</p>}
            </div>
          )}

          {/* Prev/Next overlays */}
          {currentIndex > 0 && (
            <button
              onClick={goPrev}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/50 hover:bg-black/80 flex items-center justify-center text-white transition"
            >
              <ChevronLeft size={20} />
            </button>
          )}
          {currentIndex < slides.length - 1 && (
            <button
              onClick={goNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/50 hover:bg-black/80 flex items-center justify-center text-white transition"
            >
              <ChevronRight size={20} />
            </button>
          )}

          {/* Slide counter */}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/60 text-white text-xs font-medium">
            {currentIndex + 1} / {slides.length}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-gray-700/50">
        <div className="text-sm text-muted truncate flex-1">
          {current?.title || `Slide ${currentIndex + 1}`}
        </div>
        <div className="flex items-center gap-2">
          {/* Dot indicators */}
          <div className="flex gap-1 mr-2">
            {slides.map((_, i) => (
              <button
                key={i}
                onClick={() => onIndexChange(i)}
                className={`w-2 h-2 rounded-full transition ${
                  i === currentIndex ? "bg-accent" : "bg-gray-600 hover:bg-gray-400"
                }`}
              />
            ))}
          </div>
          {onPresent && (
            <button
              onClick={onPresent}
              className="p-1.5 rounded-lg hover:bg-surface-elevated text-muted hover:text-white transition"
              title="Present full screen"
            >
              <Maximize2 size={16} />
            </button>
          )}
          {pptxUrl && (
            <a
              href={pptxUrl}
              download
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 text-xs font-medium transition"
            >
              <Download size={14} />
              PPTX
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
