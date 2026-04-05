import { useState, useMemo } from "react";
import {
  FileText,
  Music,
  Presentation,
  Image as ImageIcon,
  Film,
  File,
  Download,
  Trash2,
  Check,
  FolderOpen,
  FolderClosed,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type { ContentEntry } from "@/api/content";
import { downloadContent } from "@/api/content";

const CATEGORY_ICON: Record<string, typeof FileText> = {
  report: FileText,
  audio: Music,
  slides: Presentation,
  image: ImageIcon,
  video: Film,
  other: File,
};

const CATEGORY_COLOR: Record<string, string> = {
  report: "text-blue-400",
  audio: "text-purple-400",
  slides: "text-orange-400",
  image: "text-green-400",
  video: "text-red-400",
  other: "text-gray-400",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface ContentListProps {
  entries: ContentEntry[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (entry: ContentEntry) => void;
  onDelete: (id: string) => void;
}

export function ContentList({
  entries,
  selected,
  onToggleSelect,
  onOpen,
  onDelete,
}: ContentListProps) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted">
        <File className="mb-3 h-10 w-10 opacity-30" />
        <p className="text-sm">No content yet</p>
      </div>
    );
  }

  // Group entries by parent directory
  const grouped = useMemo(() => {
    const groups = new Map<string, ContentEntry[]>();
    for (const entry of entries) {
      // Extract parent dir from path: /a/b/c/file.md → b/c
      const parts = entry.path.split("/");
      const dataIdx = parts.findIndex((p) => p === "data");
      const dirParts = dataIdx >= 0 ? parts.slice(dataIdx + 1, -1) : parts.slice(-3, -1);
      const dir = dirParts.join("/") || "files";
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir)!.push(entry);
    }
    return groups;
  }, [entries]);

  return (
    <div className="flex flex-col gap-2 px-3">
      {Array.from(grouped.entries()).map(([dir, dirEntries]) => (
        <FolderSection
          key={dir}
          name={dir}
          entries={dirEntries}
          selected={selected}
          onToggleSelect={onToggleSelect}
          onOpen={onOpen}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

function FolderSection({
  name,
  entries,
  selected,
  onToggleSelect,
  onOpen,
  onDelete,
}: {
  name: string;
  entries: ContentEntry[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (entry: ContentEntry) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-text-strong hover:bg-surface-container"
      >
        {open ? (
          <>
            <ChevronDown size={14} className="text-muted shrink-0" />
            <FolderOpen size={14} className="text-accent/70 shrink-0" />
          </>
        ) : (
          <>
            <ChevronRight size={14} className="text-muted shrink-0" />
            <FolderClosed size={14} className="text-muted shrink-0" />
          </>
        )}
        <span className="truncate text-left">{name}</span>
        <span className="ml-auto text-[10px] text-muted/50 shrink-0">{entries.length}</span>
      </button>
      {open && (
        <div className="ml-3 border-l border-border/30 pl-2 space-y-1">
          {entries.map((entry) => {
        const Icon = CATEGORY_ICON[entry.category] || File;
        const color = CATEGORY_COLOR[entry.category] || "text-gray-400";
        const isSelected = selected.has(entry.id);

        return (
          <div
            key={entry.id}
            className="group flex items-center gap-2.5 rounded-xl bg-surface-container p-2.5 hover:bg-surface-elevated transition-colors cursor-pointer"
            onClick={() => onOpen(entry)}
          >
            {/* Checkbox */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(entry.id);
              }}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                isSelected
                  ? "border-accent bg-accent text-white"
                  : "border-border bg-transparent opacity-0 group-hover:opacity-100"
              }`}
            >
              {isSelected && <Check className="h-3 w-3" />}
            </button>

            {/* Icon */}
            <div className={`shrink-0 ${color}`}>
              <Icon className="h-5 w-5" />
            </div>

            {/* Info */}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-strong">
                {entry.filename}
              </p>
              <div className="flex items-center gap-2 text-[10px] text-muted">
                <span className="rounded bg-surface-light px-1.5 py-0.5 font-medium uppercase">
                  {entry.category}
                </span>
                <span>{formatSize(entry.size_bytes)}</span>
                <span>{formatDate(entry.created_at)}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  downloadContent(entry);
                }}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-light hover:text-text"
                title="Download"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(entry.id);
                }}
                className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-400"
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}
        </div>
      )}
    </div>
  );
}
