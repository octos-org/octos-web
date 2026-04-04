import {
  FileText,
  Music,
  Presentation,
  Image as ImageIcon,
  Film,
  File,
  Check,
} from "lucide-react";
import type { ContentEntry } from "@/api/content";
import { thumbnailUrl } from "@/api/content";
import { getToken } from "@/api/client";
import { useState } from "react";

const CATEGORY_ICON: Record<string, typeof FileText> = {
  report: FileText,
  audio: Music,
  slides: Presentation,
  image: ImageIcon,
  video: Film,
  other: File,
};

const CATEGORY_COLOR: Record<string, string> = {
  report: "bg-blue-500/20 text-blue-400",
  audio: "bg-purple-500/20 text-purple-400",
  slides: "bg-orange-500/20 text-orange-400",
  image: "bg-green-500/20 text-green-400",
  video: "bg-red-500/20 text-red-400",
  other: "bg-gray-500/20 text-gray-400",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface GridProps {
  entries: ContentEntry[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (entry: ContentEntry) => void;
}

function ThumbnailImage({ entry }: { entry: ContentEntry }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const token = getToken();

  if (!entry.thumbnail_path || error) {
    const Icon = CATEGORY_ICON[entry.category] || File;
    const color = CATEGORY_COLOR[entry.category] || "bg-gray-500/20 text-gray-400";
    return (
      <div
        className={`flex h-full w-full items-center justify-center ${color}`}
      >
        <Icon className="h-8 w-8" />
      </div>
    );
  }

  return (
    <>
      {!loaded && (
        <div className="flex h-full w-full items-center justify-center bg-surface-dark">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-accent" />
        </div>
      )}
      <img
        src={`${thumbnailUrl(entry.id)}${token ? `?_token=${token}` : ""}`}
        alt={entry.filename}
        className={`h-full w-full object-cover ${loaded ? "" : "hidden"}`}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
    </>
  );
}

/** Thumbnail grid view */
export function ContentGrid({ entries, selected, onToggleSelect, onOpen }: GridProps) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted">
        <File className="mb-3 h-10 w-10 opacity-30" />
        <p className="text-sm">No content yet</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2.5 px-3">
      {entries.map((entry) => {
        const isSelected = selected.has(entry.id);
        const color = CATEGORY_COLOR[entry.category] || "bg-gray-500/20 text-gray-400";

        return (
          <div
            key={entry.id}
            className="group relative cursor-pointer overflow-hidden rounded-xl border border-border bg-surface-container hover:bg-surface-elevated transition-colors"
            onClick={() => onOpen(entry)}
          >
            {/* Thumbnail */}
            <div className="aspect-video overflow-hidden bg-surface-dark">
              <ThumbnailImage entry={entry} />
            </div>

            {/* Checkbox overlay */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(entry.id);
              }}
              className={`absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded border transition-all ${
                isSelected
                  ? "border-accent bg-accent text-white"
                  : "border-white/40 bg-black/30 text-transparent opacity-0 group-hover:opacity-100"
              }`}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </button>

            {/* Info */}
            <div className="p-2">
              <p className="truncate text-xs font-medium text-text">
                {entry.filename}
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${color}`}
                >
                  {entry.category}
                </span>
                <span className="text-[10px] text-muted">
                  {formatDate(entry.created_at)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Cover flow (horizontal scroll) view */
export function ContentCoverFlow({ entries, selected, onToggleSelect, onOpen }: GridProps) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted">
        <File className="mb-3 h-10 w-10 opacity-30" />
        <p className="text-sm">No content yet</p>
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto px-3 pb-2 snap-x snap-mandatory">
      {entries.map((entry) => {
        const isSelected = selected.has(entry.id);
        const color = CATEGORY_COLOR[entry.category] || "bg-gray-500/20 text-gray-400";

        return (
          <div
            key={entry.id}
            className="group relative shrink-0 w-48 cursor-pointer snap-center overflow-hidden rounded-xl border border-border bg-surface-container hover:bg-surface-elevated transition-colors"
            onClick={() => onOpen(entry)}
          >
            {/* Large thumbnail */}
            <div className="aspect-[4/3] overflow-hidden bg-surface-dark">
              <ThumbnailImage entry={entry} />
            </div>

            {/* Checkbox */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(entry.id);
              }}
              className={`absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded border transition-all ${
                isSelected
                  ? "border-accent bg-accent text-white"
                  : "border-white/40 bg-black/30 text-transparent opacity-0 group-hover:opacity-100"
              }`}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </button>

            {/* Info */}
            <div className="p-2.5">
              <p className="truncate text-xs font-medium text-text">
                {entry.filename}
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${color}`}
                >
                  {entry.category}
                </span>
                <span className="text-[10px] text-muted">
                  {formatDate(entry.created_at)}
                </span>
              </div>
              {entry.caption && (
                <p className="mt-1 truncate text-[10px] text-muted">
                  {entry.caption}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
