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
  fetchSlidesManifest,
  inferContentCategory,
  inferGroupName,
  listSlidesFiles,
  slidesFileToContentEntry,
  type SlidesRenderManifest,
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
        className="mt-2 w-full rounded-[12px] border border-accent/50 bg-surface-container px-3 py-2 text-lg font-semibold tracking-tight text-text outline-none"
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
      className="mt-2 cursor-pointer truncate text-[1.45rem] font-semibold tracking-tight text-text-strong transition hover:text-accent"
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
  const [manifest, setManifest] = useState<SlidesRenderManifest | null>(null);
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
        const nextFiles = await listSlidesFiles(`slides/${slug}`, { sessionId });
        const nextManifest = await fetchSlidesManifest(slug, nextFiles);
        if (!stopped) {
          setFiles(nextFiles);
          setManifest(nextManifest);
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
  }, [refreshTick, sessionId, slug]);

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

  const entriesByPath = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry])),
    [entries],
  );

  const manifestImageEntries = useMemo(
    () =>
      manifest?.slides.map((slide) => {
        const existing = entriesByPath.get(slide.path);
        if (existing) return existing;

        return {
          id: slide.path,
          filename: slide.filename,
          path: slide.path,
          category: "image" as const,
          size_bytes: 0,
          created_at: manifest.generatedAt,
          thumbnail_path: null,
          session_id: null,
          tool_name: null,
          caption: "output/imgs",
        };
      }) ?? [],
    [entriesByPath, manifest],
  );

  const manifestImagePaths = useMemo(
    () => new Set(manifestImageEntries.map((entry) => entry.path)),
    [manifestImageEntries],
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
      <div className="shell-empty-state flex h-full items-center justify-center rounded-[12px] px-4 text-center text-sm text-muted">
        Failed to load project files: {error}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="shell-empty-state flex h-full items-center justify-center rounded-[12px] px-4 text-center text-sm text-muted">
        Project files will appear here after the backend scaffold finishes.
      </div>
    );
  }

  return (
    <div className="glass-panel flex h-full flex-col overflow-hidden rounded-[16px]">
      <div className="px-3 pt-3">
        <div className="glass-toolbar rounded-[14px] px-4 py-4">
          <div className="shell-kicker">Project Files</div>
          <EditableTitle value={title || slug} onSave={onRename} />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-3 pt-2">
        <div className="space-y-3">
          {grouped.map(([groupName, groupFiles]) => (
            <ProjectFileGroup
              key={groupName}
              name={groupName}
              files={groupFiles}
              manifestImageEntries={manifestImageEntries}
              manifestImagePaths={manifestImagePaths}
              entriesByPath={entriesByPath}
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
  manifestImageEntries,
  manifestImagePaths,
  entriesByPath,
  onOpenFile,
}: {
  name: string;
  files: SlidesFileEntry[];
  manifestImageEntries: ContentEntry[];
  manifestImagePaths: Set<string>;
  entriesByPath: Map<string, ContentEntry>;
  onOpenFile: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="glass-section rounded-[12px] p-1.5">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2.5 text-left text-xs font-semibold text-text-strong hover:bg-surface-elevated/60"
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
        <div className="ml-3 mt-2 space-y-2 border-l border-border/40 pl-3">
          {files.map((file) => {
            const entry = entriesByPath.get(file.path) ?? slidesFileToContentEntry(file);
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
                      category === "image"
                        ? manifestImagePaths.has(entry.path)
                          ? manifestImageEntries
                          : [entry]
                        : [entry],
                    );
                  } else {
                    void downloadContent(entry);
                  }
                }}
                className="glass-file-row flex w-full items-start gap-2 rounded-[12px] px-3 py-3 text-left transition-colors hover:bg-surface-elevated/70"
              >
                <div className="glass-pill mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-muted">
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-strong">
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
