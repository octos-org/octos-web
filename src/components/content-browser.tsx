import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileText,
  FolderClosed,
  FolderOpen,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  Music,
  Presentation,
  Video,
  X,
} from "lucide-react";

import type { ContentEntry } from "@/api/content";
import { downloadContent } from "@/api/content";
import { useFileStore, type FileEntry } from "@/store/file-store";
import { AudioPlayer } from "@/components/viewers/audio-player";

interface ContentBrowserProps {
  open: boolean;
  onClose: () => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onOpenViewer: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
  sessionId: string;
  sessionTitle: string;
  onRenameTitle?: (title: string) => void;
}

function EditableTitle({
  value,
  onSave,
}: {
  value: string;
  onSave?: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing && onSave) {
    return (
      <input
        defaultValue={value}
        className="mt-1 w-full rounded-lg border border-accent/50 bg-surface-container px-2.5 py-2 text-base font-bold text-text outline-none"
        autoFocus
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next && next !== value) onSave(next);
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
    <button
      type="button"
      className="mt-1 block w-full truncate text-left text-lg font-bold text-text transition hover:text-accent"
      title="Click to rename session"
      onClick={() => onSave && setEditing(true)}
    >
      {value}
    </button>
  );
}

function inferCategory(filename: string): ContentEntry["category"] {
  if (/\.(mp3|wav|ogg|m4a|opus|flac|aac)$/i.test(filename)) return "audio";
  if (/\.(mp4|webm|mov|avi|mkv)$/i.test(filename)) return "video";
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(filename)) return "image";
  if (/\.(ppt|pptx|key)$/i.test(filename)) return "slides";
  if (/\.(md|markdown|txt|js|ts|tsx|jsx|json)$/i.test(filename)) return "report";
  return "other";
}

function fileIcon(entry: ContentEntry) {
  switch (entry.category) {
    case "audio":
      return Music;
    case "video":
      return Video;
    case "image":
      return ImageIcon;
    case "slides":
      return Presentation;
    case "report":
      return FileText;
    default:
      return File;
  }
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

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function relativeSessionPath(filePath: string): string {
  const decoded = decodePath(filePath);
  for (const root of ["workspace", "skill-output", "slides", "research"]) {
    const marker = `/${root}/`;
    const index = decoded.indexOf(marker);
    if (index >= 0) return decoded.slice(index + 1);
  }
  return decoded.split("/").slice(-2).join("/");
}

function groupNameForPath(filePath: string): string {
  const relativePath = relativeSessionPath(filePath);
  const slash = relativePath.lastIndexOf("/");
  if (slash <= 0) return "workspace";
  return relativePath.slice(0, slash);
}

function toContentEntry(file: FileEntry): ContentEntry {
  return {
    id: file.id,
    filename: file.filename,
    path: file.filePath,
    category: inferCategory(file.filename),
    size_bytes: file.size ?? 0,
    created_at: new Date(file.timestamp).toISOString(),
    thumbnail_path: null,
    session_id: file.sessionId || null,
    tool_name: file.toolName || null,
    caption: file.caption || null,
  };
}

export function ContentBrowser({
  open,
  onClose,
  isMaximized,
  onToggleMaximize,
  onOpenViewer,
  sessionId,
  sessionTitle,
  onRenameTitle,
}: ContentBrowserProps) {
  const files = useFileStore(sessionId);
  const [audioEntry, setAudioEntry] = useState<ContentEntry | null>(null);

  const entries = useMemo(() => files.map(toContentEntry), [files]);
  const imageEntries = useMemo(
    () => entries.filter((entry) => entry.category === "image"),
    [entries],
  );
  const grouped = useMemo(() => {
    const groups = new Map<string, ContentEntry[]>();
    for (const entry of entries) {
      const groupName = groupNameForPath(entry.path);
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(entry);
    }

    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, groupEntries]) => [
        name,
        [...groupEntries].sort((a, b) => a.filename.localeCompare(b.filename)),
      ] as const);
  }, [entries]);

  if (!open) return null;

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <EditableTitle value={sessionTitle} onSave={onRenameTitle} />
            </div>
            {entries.length > 0 && (
              <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                {entries.length}
              </span>
            )}
          </div>
          <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted/70">
            Session Files
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleMaximize}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-container hover:text-text"
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-container hover:text-text"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {audioEntry && (
        <AudioPlayer entry={audioEntry} onClose={() => setAudioEntry(null)} />
      )}

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {entries.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">
            Files generated in this session will appear here.
          </div>
        ) : (
          <div className="space-y-2">
            {grouped.map(([groupName, groupEntries]) => (
              <FileGroup
                key={groupName}
                name={groupName}
                entries={groupEntries}
                onOpen={(entry) => {
                  if (entry.category === "audio") {
                    setAudioEntry(entry);
                    return;
                  }

                  onOpenViewer(
                    entry,
                    entry.category === "image" ? imageEntries : [entry],
                  );
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileGroup({
  name,
  entries,
  onOpen,
}: {
  name: string;
  entries: ContentEntry[];
  onOpen: (entry: ContentEntry) => void;
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
          {entries.length}
        </span>
      </button>
      {open && (
        <div className="ml-3 space-y-1 border-l border-border/30 pl-2">
          {entries.map((entry) => {
            const Icon = fileIcon(entry);
            const opensViewer =
              entry.category === "image" ||
              entry.category === "video" ||
              entry.category === "audio" ||
              /\.(md|markdown|txt|js|ts|tsx|jsx|json)$/i.test(entry.filename);

            return (
              <div
                key={entry.id}
                className="flex items-start gap-2 rounded-xl bg-surface-container px-2.5 py-2 transition-colors hover:bg-surface-elevated"
              >
                <button
                  onClick={() => {
                    if (opensViewer) {
                      onOpen(entry);
                    } else {
                      void downloadContent(entry);
                    }
                  }}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                >
                <div className="mt-0.5 shrink-0 text-muted">
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-text-strong">
                    {entry.filename}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted">
                    <span>{formatSize(entry.size_bytes)}</span>
                    <span>{formatTime(entry.created_at)}</span>
                    <span className="uppercase tracking-[0.14em] text-muted/60">
                      {entry.category}
                    </span>
                  </div>
                </div>
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    void downloadContent(entry);
                  }}
                  className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-surface-dark hover:text-accent"
                  title="Download"
                >
                  <Download size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
