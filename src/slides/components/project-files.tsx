import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  FolderClosed,
  FolderOpen,
  Image as ImageIcon,
  Presentation,
} from "lucide-react";

import type { ContentEntry } from "@/api/content";
import { downloadContent } from "@/api/content";

import {
  inferContentCategory,
  inferGroupName,
  listSlidesFiles,
  slidesFileToContentEntry,
  type SlidesFileEntry,
} from "../api";

interface ProjectFilesProps {
  slug: string;
  title?: string;
  sessionId: string;
  onOpenFile: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
  onRename?: (title: string) => void;
}

function EditableTitle({ value, onSave }: { value: string; onSave?: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing && onSave) {
    return (
      <input
        defaultValue={value}
        className="mt-1 w-full text-[11px] text-muted bg-surface-container rounded px-1 py-0.5 outline-none border border-accent/50"
        autoFocus
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== value) onSave(v);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <div
      className="mt-1 text-[11px] text-muted/70 cursor-pointer hover:text-accent transition truncate"
      onClick={() => onSave && setEditing(true)}
      title="Click to rename"
    >
      {value}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fileIcon(file: SlidesFileEntry) {
  const category = inferContentCategory(file);
  if (category === "slides") return Presentation;
  if (category === "image") return ImageIcon;
  if (/\.(md|markdown|txt|js|ts|tsx|jsx|json)$/i.test(file.filename)) return FileText;
  return File;
}

export function ProjectFiles({ slug, title, sessionId, onOpenFile, onRename }: ProjectFilesProps) {
  const [files, setFiles] = useState<SlidesFileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const triggerRefresh = useCallback(() => {
    setRefreshTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const nextFiles = await listSlidesFiles(`slides/${slug}`);
        if (!stopped) {
          setFiles(nextFiles);
          setError(null);
        }
      } catch (err) {
        if (!stopped) {
          setError(err instanceof Error ? err.message : "Failed to load files");
        }
      } finally {
        if (!stopped) pollTimer = setTimeout(load, 2500);
      }
    }

    void load();

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [refreshTick, slug]);

  useEffect(() => {
    function matchesSession(detail: unknown): boolean {
      return (
        !!detail &&
        typeof detail === "object" &&
        "sessionId" in detail &&
        detail.sessionId === sessionId
      );
    }

    function handleEvent(event: Event) {
      const detail =
        event instanceof CustomEvent ? (event.detail as unknown) : undefined;
      if (!matchesSession(detail)) return;
      triggerRefresh();
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        triggerRefresh();
      }
    }

    window.addEventListener("focus", triggerRefresh);
    window.addEventListener("crew:file", handleEvent);
    window.addEventListener("crew:bg_tasks", handleEvent);
    window.addEventListener("crew:task_status", handleEvent);
    window.addEventListener("crew:tool_progress", handleEvent);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", triggerRefresh);
      window.removeEventListener("crew:file", handleEvent);
      window.removeEventListener("crew:bg_tasks", handleEvent);
      window.removeEventListener("crew:task_status", handleEvent);
      window.removeEventListener("crew:tool_progress", handleEvent);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [sessionId, triggerRefresh]);

  const entries = useMemo(
    () => files.map((file) => slidesFileToContentEntry(file)),
    [files],
  );

  const imageEntries = useMemo(
    () => entries.filter((entry) => entry.category === "image"),
    [entries],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, SlidesFileEntry[]>();
    for (const file of files) {
      const key = inferGroupName(file, slug);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(file);
    }

    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, groupFiles]) => [
        name,
        [...groupFiles].sort((a, b) => a.filename.localeCompare(b.filename)),
      ] as const);
  }, [files, slug]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">
        Failed to load project files: {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">
        Project files will appear here after the backend scaffold finishes.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
          Project Files
        </div>
        <EditableTitle value={title || slug} onSave={onRename} />
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-2">
          {grouped.map(([groupName, groupFiles]) => (
            <ProjectFileGroup
              key={groupName}
              name={groupName}
              files={groupFiles}
              imageEntries={imageEntries}
              entriesByPath={entries}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ProjectFileGroup({
  name,
  files,
  imageEntries,
  entriesByPath,
  onOpenFile,
}: {
  name: string;
  files: SlidesFileEntry[];
  imageEntries: ContentEntry[];
  entriesByPath: ContentEntry[];
  onOpenFile: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-text-strong hover:bg-surface-container"
      >
        {open ? (
          <>
            <ChevronDown size={14} className="shrink-0 text-muted" />
            <FolderOpen size={14} className="shrink-0 text-accent/70" />
          </>
        ) : (
          <>
            <ChevronRight size={14} className="shrink-0 text-muted" />
            <FolderClosed size={14} className="shrink-0 text-muted" />
          </>
        )}
        <span className="truncate">{name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted/50">
          {files.length}
        </span>
      </button>
      {open && (
        <div className="ml-3 space-y-1 border-l border-border/30 pl-2">
          {files.map((file) => {
            const entry =
              entriesByPath.find((candidate) => candidate.path === file.path) ??
              slidesFileToContentEntry(file);
            const Icon = fileIcon(file);
            const category = inferContentCategory(file);
            const opensViewer =
              category === "image" ||
              /\.(md|markdown|txt|js|ts|tsx|jsx|json)$/i.test(file.filename);

            return (
              <button
                key={file.path}
                onClick={() => {
                  if (opensViewer) {
                    onOpenFile(
                      entry,
                      category === "image" ? imageEntries : [entry],
                    );
                  } else {
                    void downloadContent(entry);
                  }
                }}
                className="flex w-full items-start gap-2 rounded-xl bg-surface-container px-2.5 py-2 text-left transition-colors hover:bg-surface-elevated"
              >
                <div className="mt-0.5 shrink-0 text-muted">
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-text-strong">
                    {file.filename}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted">
                    <span>{formatSize(file.size)}</span>
                    <span>{formatTime(file.modified)}</span>
                    <span className="uppercase tracking-[0.14em] text-muted/60">
                      {category}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
