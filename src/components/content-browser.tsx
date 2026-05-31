import { useMemo, useState, type ReactNode } from "react";
import {
  Check,
  Clock3,
  Download,
  Edit3,
  File,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Maximize2,
  Minimize2,
  Music,
  Presentation,
  Search,
  Trash2,
  Video,
  X,
} from "lucide-react";

import type { ContentEntry } from "@/api/content";
import { downloadContent } from "@/api/content";
import { buildAuthenticatedFileUrl } from "@/api/files";
import {
  removeFile,
  renameFile,
  useAllFiles,
  type FileEntry,
} from "@/store/file-store";
import { AudioPlayer } from "@/components/viewers/audio-player";
import { SessionTitleEditor } from "@/components/session-title-editor";

interface ContentBrowserProps {
  open: boolean;
  onClose: () => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onOpenViewer: (entry: ContentEntry, allEntries: ContentEntry[]) => void;
  sessionId: string;
  sessionTitle: string;
  sessionLabels?: Record<string, string>;
  onRenameTitle?: (title: string) => void;
}

type CategoryFilter = ContentEntry["category"] | "all";
type DateFilter = "all" | "today" | "yesterday" | "7d" | "30d";
type ViewMode = "timeline" | "grid" | "list";

const CATEGORY_OPTIONS: { value: CategoryFilter; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "report", label: "Reports" },
  { value: "audio", label: "Audio" },
  { value: "slides", label: "Slides" },
  { value: "image", label: "Images" },
  { value: "video", label: "Video" },
  { value: "other", label: "Documents" },
];

const DATE_OPTIONS: { value: DateFilter; label: string }[] = [
  { value: "all", label: "Any date" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

function inferCategory(filename: string): ContentEntry["category"] {
  if (/\.(mp3|wav|ogg|m4a|opus|flac|aac)$/i.test(filename)) return "audio";
  if (/\.(mp4|webm|mov|avi|mkv)$/i.test(filename)) return "video";
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(filename)) return "image";
  if (/\.(ppt|pptx|key)$/i.test(filename)) return "slides";
  if (/\.(md|markdown|txt|js|ts|tsx|jsx|json|pdf|doc|docx)$/i.test(filename)) {
    return "report";
  }
  return "other";
}

function renderFileIcon(entry: ContentEntry, size: number) {
  switch (entry.category) {
    case "audio":
      return <Music size={size} />;
    case "video":
      return <Video size={size} />;
    case "image":
      return <ImageIcon size={size} />;
    case "slides":
      return <Presentation size={size} />;
    case "report":
      return <FileText size={size} />;
    default:
      return <File size={size} />;
  }
}

function categoryTone(category: ContentEntry["category"]): string {
  switch (category) {
    case "audio":
      return "bg-purple-500/15 text-purple-300";
    case "video":
      return "bg-red-500/15 text-red-300";
    case "image":
      return "bg-emerald-500/15 text-emerald-300";
    case "slides":
      return "bg-amber-500/15 text-amber-300";
    case "report":
      return "bg-sky-500/15 text-sky-300";
    default:
      return "bg-surface-light text-muted";
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

function dayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 10);
}

function dayLabel(key: string): string {
  if (key === "unknown") return "Unknown date";
  const date = new Date(`${key}T00:00:00`);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (key === today.toISOString().slice(0, 10)) return "Today";
  if (key === yesterday.toISOString().slice(0, 10)) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function dateMatches(value: string, filter: DateFilter): boolean {
  if (filter === "all") return true;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfToday.getDate() + 1);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfToday.getDate() - 1);

  if (filter === "today") return date >= startOfToday && date < startOfTomorrow;
  if (filter === "yesterday") return date >= startOfYesterday && date < startOfToday;

  const windowStart = new Date(startOfToday);
  windowStart.setDate(startOfToday.getDate() - (filter === "7d" ? 6 : 29));
  return date >= windowStart;
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

function isOpenable(entry: ContentEntry): boolean {
  return (
    entry.category === "image" ||
    entry.category === "video" ||
    entry.category === "audio" ||
    /\.(md|markdown|txt|js|ts|tsx|jsx|json)$/i.test(entry.filename)
  );
}

function sessionLabelForEntry(
  entry: ContentEntry,
  currentSessionId: string,
  currentSessionTitle: string,
  sessionLabels: Record<string, string>,
): string {
  if (!entry.session_id) return "Unscoped";
  if (entry.session_id === "_content") return "Profile library";
  if (entry.session_id === currentSessionId) return currentSessionTitle;
  return sessionLabels[entry.session_id] || entry.session_id;
}

function groupByDay(entries: ContentEntry[]): [string, ContentEntry[]][] {
  const groups = new Map<string, ContentEntry[]>();
  for (const entry of entries) {
    const key = dayKey(entry.created_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(entry);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
}

export function ContentBrowser({
  open,
  onClose,
  isMaximized,
  onToggleMaximize,
  onOpenViewer,
  sessionId,
  sessionTitle,
  sessionLabels = {},
  onRenameTitle,
}: ContentBrowserProps) {
  const files = useAllFiles();
  const [audioEntry, setAudioEntry] = useState<ContentEntry | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const entries = useMemo(
    () =>
      files
        .map(toContentEntry)
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        ),
    [files],
  );
  const imageEntries = useMemo(
    () => entries.filter((entry) => entry.category === "image"),
    [entries],
  );
  const filteredEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter((entry) => {
      const sessionLabel = sessionLabelForEntry(
        entry,
        sessionId,
        sessionTitle,
        sessionLabels,
      );
      const haystack = [
        entry.filename,
        entry.path,
        entry.caption,
        entry.tool_name,
        sessionLabel,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        (!query || haystack.includes(query)) &&
        (category === "all" || entry.category === category) &&
        dateMatches(entry.created_at, dateFilter)
      );
    });
  }, [category, dateFilter, entries, search, sessionId, sessionLabels, sessionTitle]);
  const selectedEntries = useMemo(
    () => filteredEntries.filter((entry) => selectedIds.has(entry.id)),
    [filteredEntries, selectedIds],
  );

  if (!open) return null;

  const openEntry = (entry: ContentEntry) => {
    if (entry.category === "audio") {
      setAudioEntry(entry);
      return;
    }
    if (isOpenable(entry)) {
      onOpenViewer(entry, entry.category === "image" ? imageEntries : [entry]);
      return;
    }
    void downloadContent(entry);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const deleteEntries = (ids: string[]) => {
    for (const id of ids) removeFile(id);
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (audioEntry && ids.includes(audioEntry.id)) {
      setAudioEntry(null);
    }
  };

  const downloadSelected = () => {
    void Promise.allSettled(selectedEntries.map((entry) => downloadContent(entry)));
  };

  const startRename = (entry: ContentEntry) => {
    setRenamingId(entry.id);
    setRenameDraft(entry.filename);
  };

  const commitRename = () => {
    if (!renamingId) return;
    renameFile(renamingId, renameDraft);
    setRenamingId(null);
    setRenameDraft("");
  };

  const selectVisible = () => {
    setSelectedIds(new Set(filteredEntries.map((entry) => entry.id)));
  };

  return (
    <div className="glass-panel flex h-full flex-col overflow-hidden rounded-[16px]">
      <div className="px-3 pt-3">
        <div className="glass-toolbar flex flex-wrap items-start justify-between gap-3 rounded-[14px] px-4 py-4">
          <div className="min-w-0 flex-1">
            <div className="shell-kicker">Session Files</div>
            <SessionTitleEditor
              value={sessionTitle}
              onSave={onRenameTitle}
              buttonClassName="mt-2 w-full text-left text-[1.24rem] font-semibold tracking-tight text-text-strong transition hover:text-accent"
              inputClassName="mt-2 w-full rounded-[12px] border border-accent/40 bg-surface-container px-3 py-2.5 text-[1.08rem] font-semibold tracking-tight text-text outline-none"
              testId="content-session-title"
            />
            <div className="mt-2 text-xs text-muted">
              {filteredEntries.length} of {entries.length} files
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleMaximize}
              className="glass-icon-button rounded-[10px] p-2"
              title={isMaximized ? "Restore" : "Maximize"}
              aria-label={isMaximized ? "Restore files panel" : "Maximize files panel"}
            >
              {isMaximized ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={onClose}
              className="glass-icon-button rounded-[10px] p-2"
              title="Close"
              aria-label="Close files panel"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mt-2 grid gap-2 xl:grid-cols-[minmax(180px,1fr)_auto_auto]">
          <label className="glass-section flex min-w-0 items-center gap-2 rounded-[12px] px-3 py-2">
            <Search size={14} className="shrink-0 text-muted" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search files, sessions, tools"
              className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted/70"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as CategoryFilter)}
              className="glass-section rounded-[12px] px-3 py-2 text-sm text-text outline-none"
              aria-label="Filter by type"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value as DateFilter)}
              className="glass-section rounded-[12px] px-3 py-2 text-sm text-text outline-none"
              aria-label="Filter by date"
            >
              {DATE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="glass-section flex items-center gap-1 rounded-[12px] p-1">
            <ModeButton active={viewMode === "timeline"} onClick={() => setViewMode("timeline")}>
              <Clock3 size={14} />
              <span>Timeline</span>
            </ModeButton>
            <ModeButton active={viewMode === "grid"} onClick={() => setViewMode("grid")}>
              <LayoutGrid size={14} />
              <span>Grid</span>
            </ModeButton>
            <ModeButton active={viewMode === "list"} onClick={() => setViewMode("list")}>
              <List size={14} />
              <span>List</span>
            </ModeButton>
          </div>
        </div>

        {selectedEntries.length > 0 && (
          <div className="glass-section mt-2 flex flex-wrap items-center gap-2 rounded-[12px] px-3 py-2 text-xs text-muted">
            <span className="font-medium text-text">
              {selectedEntries.length} selected
            </span>
            <button
              onClick={downloadSelected}
              className="glass-icon-button rounded-[9px] px-2 py-1.5 hover:text-accent"
            >
              <Download size={13} />
              <span>Download</span>
            </button>
            <button
              onClick={() => deleteEntries(selectedEntries.map((entry) => entry.id))}
              className="glass-icon-button rounded-[9px] px-2 py-1.5 hover:text-red-300"
            >
              <Trash2 size={13} />
              <span>Delete</span>
            </button>
            <button
              onClick={() => setSelectedIds(new Set())}
              className="ml-auto rounded-[9px] px-2 py-1.5 text-muted hover:bg-surface-elevated hover:text-text"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {audioEntry && (
        <AudioPlayer entry={audioEntry} onClose={() => setAudioEntry(null)} />
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {entries.length === 0 ? (
          <div className="shell-empty-state flex h-full items-center justify-center rounded-[12px] px-5 text-center text-sm text-muted">
            Files generated in your sessions will appear here.
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="shell-empty-state flex h-full items-center justify-center rounded-[12px] px-5 text-center text-sm text-muted">
            No files match the current filters.
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted">
              <button
                onClick={selectVisible}
                className="rounded-[9px] px-2 py-1.5 hover:bg-surface-elevated hover:text-text"
              >
                Select visible
              </button>
              <span>{viewMode === "timeline" ? "Newest first" : "Sorted by recency"}</span>
            </div>
            {viewMode === "timeline" ? (
              <TimelineView
                entries={filteredEntries}
                selectedIds={selectedIds}
                renamingId={renamingId}
                renameDraft={renameDraft}
                onRenameDraft={setRenameDraft}
                onCommitRename={commitRename}
                onCancelRename={() => setRenamingId(null)}
                onStartRename={startRename}
                onToggleSelected={toggleSelected}
                onOpen={openEntry}
                onDelete={(entry) => deleteEntries([entry.id])}
                sessionLabel={(entry) =>
                  sessionLabelForEntry(entry, sessionId, sessionTitle, sessionLabels)
                }
              />
            ) : viewMode === "grid" ? (
              <GridView
                entries={filteredEntries}
                selectedIds={selectedIds}
                isMaximized={isMaximized}
                renamingId={renamingId}
                renameDraft={renameDraft}
                onRenameDraft={setRenameDraft}
                onCommitRename={commitRename}
                onCancelRename={() => setRenamingId(null)}
                onStartRename={startRename}
                onToggleSelected={toggleSelected}
                onOpen={openEntry}
                onDelete={(entry) => deleteEntries([entry.id])}
                sessionLabel={(entry) =>
                  sessionLabelForEntry(entry, sessionId, sessionTitle, sessionLabels)
                }
              />
            ) : (
              <ListView
                entries={filteredEntries}
                selectedIds={selectedIds}
                renamingId={renamingId}
                renameDraft={renameDraft}
                onRenameDraft={setRenameDraft}
                onCommitRename={commitRename}
                onCancelRename={() => setRenamingId(null)}
                onStartRename={startRename}
                onToggleSelected={toggleSelected}
                onOpen={openEntry}
                onDelete={(entry) => deleteEntries([entry.id])}
                sessionLabel={(entry) =>
                  sessionLabelForEntry(entry, sessionId, sessionTitle, sessionLabels)
                }
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-xs font-medium ${
        active ? "bg-accent text-white" : "text-muted hover:bg-surface-elevated hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

interface EntryActionProps {
  entry: ContentEntry;
  selected: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraft: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onStartRename: (entry: ContentEntry) => void;
  onToggleSelected: (id: string) => void;
  onOpen: (entry: ContentEntry) => void;
  onDelete: (entry: ContentEntry) => void;
  sessionLabel: (entry: ContentEntry) => string;
}

function EntryActions({
  entry,
  selected,
  onToggleSelected,
  onStartRename,
  onDelete,
}: EntryActionProps) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        onClick={(event) => {
          event.stopPropagation();
          onToggleSelected(entry.id);
        }}
        className={`flex h-7 w-7 items-center justify-center rounded-[9px] border ${
          selected
            ? "border-accent bg-accent text-white"
            : "border-border text-transparent hover:text-muted"
        }`}
        title={selected ? "Deselect" : "Select"}
        aria-label={selected ? `Deselect ${entry.filename}` : `Select ${entry.filename}`}
      >
        <Check size={13} />
      </button>
      <button
        onClick={(event) => {
          event.stopPropagation();
          void downloadContent(entry);
        }}
        className="glass-icon-button rounded-[9px] p-1.5 hover:text-accent"
        title="Download"
        aria-label={`Download ${entry.filename}`}
      >
        <Download size={13} />
      </button>
      <button
        onClick={(event) => {
          event.stopPropagation();
          onStartRename(entry);
        }}
        className="glass-icon-button rounded-[9px] p-1.5 hover:text-accent"
        title="Rename"
        aria-label={`Rename ${entry.filename}`}
      >
        <Edit3 size={13} />
      </button>
      <button
        onClick={(event) => {
          event.stopPropagation();
          onDelete(entry);
        }}
        className="glass-icon-button rounded-[9px] p-1.5 hover:text-red-300"
        title="Delete"
        aria-label={`Delete ${entry.filename}`}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function RenameField({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCommit();
          if (event.key === "Escape") onCancel();
        }}
        className="min-w-0 flex-1 rounded-[9px] border border-accent/40 bg-surface-container px-2 py-1.5 text-sm text-text outline-none"
      />
      <button
        onClick={onCommit}
        className="glass-icon-button rounded-[9px] p-1.5 text-emerald-300"
        title="Save rename"
      >
        <Check size={13} />
      </button>
      <button
        onClick={onCancel}
        className="glass-icon-button rounded-[9px] p-1.5 text-muted"
        title="Cancel rename"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function EntryMeta({
  entry,
  sessionLabel,
}: {
  entry: ContentEntry;
  sessionLabel: (entry: ContentEntry) => string;
}) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted">
      <span className={`rounded-md px-1.5 py-0.5 font-semibold uppercase ${categoryTone(entry.category)}`}>
        {entry.category}
      </span>
      <span>{formatSize(entry.size_bytes)}</span>
      <span>{formatTime(entry.created_at)}</span>
      <span>{sessionLabel(entry)}</span>
      {entry.tool_name && <span>{entry.tool_name}</span>}
    </div>
  );
}

function EntryPreview({ entry }: { entry: ContentEntry }) {
  if (entry.category === "image") {
    return (
      <img
        src={buildAuthenticatedFileUrl(entry.path)}
        alt={entry.filename}
        className="h-full w-full object-cover"
        loading="lazy"
      />
    );
  }
  return (
    <div className={`flex h-full w-full items-center justify-center ${categoryTone(entry.category)}`}>
      {renderFileIcon(entry, 32)}
    </div>
  );
}

function EntryRow(props: EntryActionProps) {
  return (
    <div
      className="glass-file-row flex items-start gap-3 rounded-[12px] px-3 py-3 transition-colors hover:bg-surface-elevated/70"
      onClick={() => props.onOpen(props.entry)}
      data-testid="content-file-row"
    >
      <div className="glass-pill mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-muted">
        {renderFileIcon(props.entry, 15)}
      </div>
      <div className="min-w-0 flex-1">
        {props.renaming ? (
          <RenameField
            value={props.renameDraft}
            onChange={props.onRenameDraft}
            onCommit={props.onCommitRename}
            onCancel={props.onCancelRename}
          />
        ) : (
          <div className="truncate text-sm font-medium text-text-strong">
            {props.entry.filename}
          </div>
        )}
        <EntryMeta entry={props.entry} sessionLabel={props.sessionLabel} />
        {props.entry.caption && (
          <div className="mt-1 truncate text-xs text-muted/80">{props.entry.caption}</div>
        )}
      </div>
      <EntryActions {...props} />
    </div>
  );
}

function TimelineView(props: Omit<EntryActionProps, "entry" | "selected" | "renaming"> & {
  entries: ContentEntry[];
  selectedIds: Set<string>;
  renamingId: string | null;
}) {
  return (
    <div className="space-y-3">
      {groupByDay(props.entries).map(([key, entries]) => (
        <section key={key} className="space-y-2">
          <div className="sticky top-0 z-10 glass-toolbar rounded-[10px] px-3 py-2 text-xs font-semibold text-text-strong">
            {dayLabel(key)}
          </div>
          <div className="space-y-2">
            {entries.map((entry) => (
              <EntryRow
                key={entry.id}
                {...props}
                entry={entry}
                selected={props.selectedIds.has(entry.id)}
                renaming={props.renamingId === entry.id}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function GridView(props: Omit<EntryActionProps, "entry" | "selected" | "renaming"> & {
  entries: ContentEntry[];
  selectedIds: Set<string>;
  isMaximized: boolean;
  renamingId: string | null;
}) {
  return (
    <div
      className={`grid gap-3 ${
        props.isMaximized
          ? "grid-cols-[repeat(auto-fill,minmax(210px,1fr))]"
          : "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]"
      }`}
    >
      {props.entries.map((entry) => (
        <EntryCard
          key={entry.id}
          {...props}
          entry={entry}
          selected={props.selectedIds.has(entry.id)}
          renaming={props.renamingId === entry.id}
        />
      ))}
    </div>
  );
}

function EntryCard(props: EntryActionProps) {
  return (
    <div
      className="group overflow-hidden rounded-[12px] border border-border bg-surface-container transition-colors hover:bg-surface-elevated"
      onClick={() => props.onOpen(props.entry)}
      data-testid="content-file-card"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-surface-dark">
        <EntryPreview entry={props.entry} />
        <div className="absolute left-2 top-2">
          <button
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleSelected(props.entry.id);
            }}
            className={`flex h-7 w-7 items-center justify-center rounded-[9px] border ${
              props.selected
                ? "border-accent bg-accent text-white"
                : "border-white/40 bg-black/30 text-transparent group-hover:text-white"
            }`}
            aria-label={props.selected ? `Deselect ${props.entry.filename}` : `Select ${props.entry.filename}`}
          >
            <Check size={13} />
          </button>
        </div>
      </div>
      <div className="space-y-2 p-3">
        {props.renaming ? (
          <RenameField
            value={props.renameDraft}
            onChange={props.onRenameDraft}
            onCommit={props.onCommitRename}
            onCancel={props.onCancelRename}
          />
        ) : (
          <div className="truncate text-sm font-medium text-text-strong">
            {props.entry.filename}
          </div>
        )}
        <EntryMeta entry={props.entry} sessionLabel={props.sessionLabel} />
        <EntryActions {...props} />
      </div>
    </div>
  );
}

function ListView(props: Omit<EntryActionProps, "entry" | "selected" | "renaming"> & {
  entries: ContentEntry[];
  selectedIds: Set<string>;
  renamingId: string | null;
}) {
  return (
    <div className="space-y-2">
      {props.entries.map((entry) => (
        <EntryRow
          key={entry.id}
          {...props}
          entry={entry}
          selected={props.selectedIds.has(entry.id)}
          renaming={props.renamingId === entry.id}
        />
      ))}
    </div>
  );
}
