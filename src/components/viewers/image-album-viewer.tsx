import { useState, useEffect, useCallback } from "react";
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import type { ContentEntry } from "@/api/content";
import { buildAuthenticatedFileUrl } from "@/api/files";

interface ImageAlbumViewerProps {
  entries: ContentEntry[];
  initialIndex: number;
  onClose: () => void;
}

function imageUrl(entry: ContentEntry): string {
  return buildAuthenticatedFileUrl(entry.path);
}

export function ImageAlbumViewer({
  entries,
  initialIndex,
  onClose,
}: ImageAlbumViewerProps) {
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);

  const entry = entries[index];
  const hasPrev = index > 0;
  const hasNext = index < entries.length - 1;

  const goPrev = useCallback(() => {
    if (hasPrev) {
      setIndex((i) => i - 1);
      setZoom(1);
    }
  }, [hasPrev]);

  const goNext = useCallback(() => {
    if (hasNext) {
      setIndex((i) => i + 1);
      setZoom(1);
    }
  }, [hasNext]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, goPrev, goNext]);

  if (!entry) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95"
      onClick={onClose}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm text-white/70">
          {index + 1} / {entries.length}
          <span className="ml-3 text-white/50">{entry.filename}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setZoom((z) => Math.min(3, z + 0.5))}
            className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"
          >
            <ZoomIn className="h-5 w-5" />
          </button>
          <button
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.5))}
            className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"
          >
            <ZoomOut className="h-5 w-5" />
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-white/60 hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Image */}
      <div
        className="flex flex-1 items-center justify-center overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {hasPrev && (
          <button
            onClick={goPrev}
            className="absolute left-4 z-10 rounded-full bg-black/50 p-3 text-white/70 hover:bg-black/70 hover:text-white"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}

        <img
          src={imageUrl(entry)}
          alt={entry.filename}
          className="max-h-[80vh] max-w-[90vw] object-contain transition-transform duration-200"
          style={{ transform: `scale(${zoom})` }}
          draggable={false}
        />

        {hasNext && (
          <button
            onClick={goNext}
            className="absolute right-4 z-10 rounded-full bg-black/50 p-3 text-white/70 hover:bg-black/70 hover:text-white"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>

      {/* Thumbnail strip */}
      {entries.length > 1 && (
        <div
          className="flex gap-2 overflow-x-auto px-4 py-3"
          onClick={(e) => e.stopPropagation()}
        >
          {entries.map((e, i) => (
            <button
              key={e.id}
              onClick={() => {
                setIndex(i);
                setZoom(1);
              }}
              className={`shrink-0 overflow-hidden rounded-lg border-2 transition-all ${
                i === index
                  ? "border-accent opacity-100"
                  : "border-transparent opacity-50 hover:opacity-80"
              }`}
            >
              <img
                src={imageUrl(e)}
                alt={e.filename}
                className="h-12 w-16 object-cover"
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
