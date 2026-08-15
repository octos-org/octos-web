import { useState, useEffect, useCallback } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  Pencil,
  X,
  ArrowLeft,
  ArrowRight,
  Trash2,
  Check,
} from "lucide-react";
import { SLIDE_ASPECT_RATIO } from "../constants";
import type { Slide, SlideLayout } from "../types";
import { useAuthenticatedFileUrl } from "./authenticated-file-image";

const LAYOUT_OPTIONS: Array<{ value: SlideLayout; label: string }> = [
  { value: "title", label: "Title" },
  { value: "content", label: "Content" },
  { value: "two-column", label: "Two column" },
  { value: "image-full", label: "Full image" },
  { value: "agenda", label: "Agenda" },
  { value: "conclusion", label: "Conclusion" },
];

interface Props {
  slides: Slide[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
  pptxUrl?: string;
  onPresent?: () => void;
  /** Changes when slide images are regenerated — forces image re-fetch */
  version?: string;
  /** Manual-edit affordances (2026-08 audit #320). When omitted the
   *  preview stays read-only. */
  onUpdate?: (index: number, update: Partial<Slide>) => void;
  onRemove?: (index: number) => void;
  onMove?: (from: number, to: number) => void;
}

export default function SlidePreview({
  slides,
  currentIndex,
  onIndexChange,
  pptxUrl,
  onPresent,
  version,
  onUpdate,
  onRemove,
  onMove,
}: Props) {
  const [imgError, setImgError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [layoutDraft, setLayoutDraft] = useState<SlideLayout>("content");

  const current = slides[currentIndex];
  const currentImageUrl = useAuthenticatedFileUrl(current?.thumbnailUrl, version);

  // Sync drafts whenever the edited slide changes.
  useEffect(() => {
    setTitleDraft(current?.title ?? "");
    setNotesDraft(current?.notes ?? "");
    setLayoutDraft(current?.layout ?? "content");
    setConfirmingDelete(false);
  }, [currentIndex, current?.layout, current?.notes, current?.title]);

  const commitEdits = useCallback(() => {
    if (!current || !onUpdate) return;
    onUpdate(currentIndex, {
      title: titleDraft.trim() || current.title,
      notes: notesDraft,
      layout: layoutDraft,
    });
    setEditing(false);
  }, [current, currentIndex, layoutDraft, notesDraft, onUpdate, titleDraft]);

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
          className="relative w-full bg-black rounded-lg overflow-hidden shadow-lg"
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

      {/* Manual edit panel (2026-08 audit #320): AI-generated decks can
          finally be corrected by hand — title/notes/layout plus reorder
          and delete. Only rendered when the parent supplies the
          context-backed callbacks. */}
      {editing && current && onUpdate && (
        <div className="border-t border-gray-700/50 px-4 py-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                Title
              </span>
              <input
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface-container px-3 py-2 text-sm text-text outline-none focus:border-accent/40"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">
                Layout
              </span>
              <select
                value={layoutDraft}
                onChange={(e) =>
                  setLayoutDraft(e.target.value as SlideLayout)
                }
                className="w-full rounded-lg border border-border bg-surface-container px-3 py-2 text-sm text-text outline-none focus:border-accent/40"
              >
                {LAYOUT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">
              Notes
            </span>
            <textarea
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-border bg-surface-container px-3 py-2 text-sm text-text outline-none focus:border-accent/40"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onMove?.(currentIndex, currentIndex - 1)}
              disabled={currentIndex === 0}
              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-text disabled:opacity-30"
              title="Move slide earlier"
            >
              <ArrowLeft size={13} /> Earlier
            </button>
            <button
              type="button"
              onClick={() => onMove?.(currentIndex, currentIndex + 1)}
              disabled={currentIndex === slides.length - 1}
              className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-text disabled:opacity-30"
              title="Move slide later"
            >
              Later <ArrowRight size={13} />
            </button>
            {confirmingDelete ? (
              <span className="flex items-center gap-2">
                <span className="text-xs text-red-400">Delete this slide?</span>
                <button
                  type="button"
                  onClick={() => {
                    onRemove?.(currentIndex);
                    setEditing(false);
                    setConfirmingDelete(false);
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-600 text-white hover:bg-red-700"
                  title="Confirm delete"
                >
                  <Check size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-muted hover:text-text"
                  title="Cancel delete"
                >
                  <X size={13} />
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="flex items-center gap-1 rounded-lg bg-red-600/15 px-3 py-1.5 text-xs text-red-400 hover:bg-red-600/25"
                title="Delete this slide"
              >
                <Trash2 size={13} /> Delete
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:text-text"
              >
                <X size={13} /> Cancel
              </button>
              <button
                type="button"
                onClick={commitEdits}
                className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-dim"
              >
                <Check size={13} /> Save slide
              </button>
            </div>
          </div>
        </div>
      )}

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
          {onUpdate && (
            <button
              onClick={() => setEditing((v) => !v)}
              className={`p-1.5 rounded-lg transition ${
                editing
                  ? "bg-accent text-white"
                  : "text-muted hover:bg-surface-elevated hover:text-white"
              }`}
              title={editing ? "Close slide editor" : "Edit this slide"}
              aria-pressed={editing}
            >
              <Pencil size={16} />
            </button>
          )}
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
