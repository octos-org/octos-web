import { useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Check,
  ExternalLink,
  Eye,
  FileText,
  Image,
  Music,
  Pencil,
  Plus,
  Search,
  Table,
  Trash2,
  Video,
  X,
} from "lucide-react";

import { uploadFiles } from "@/api/chat";
import { buildAuthenticatedFileUrl } from "@/api/files";
import { invokeSkillAction } from "@/api/skill-actions";
import { useAllFiles } from "@/store/file-store";

import {
  SOURCE_IMPORT_ACTION_ID,
  SOURCE_REMOVE_ACTION_ID,
  SOURCE_RENAME_ACTION_ID,
  fileNameFromPath,
  isSourceRowReady,
  sourceKind,
  sourceRowFromSkillActionJob,
  sourcePreviewPath,
  type SourceKind,
  type SourceRow,
} from "./source-media";

interface Props {
  sessionId: string;
  /** Server file paths currently selected as grounding sources. */
  selected: string[];
  onToggle: (path: string) => void;
  /**
   * Uploaded-source rows live in the workspace (not here) so toggling
   * the pane closed cannot orphan still-selected uploads.
   */
  uploaded: SourceRow[];
  onUploaded: (rows: SourceRow[]) => void;
  onRenamed: (row: SourceRow, title: string) => void;
  onRemoved: (row: SourceRow) => void;
  /** True while the initial session file listing is in flight. */
  loading: boolean;
}

const KIND_ICONS: Record<SourceKind, LucideIcon> = {
  image: Image,
  audio: Music,
  video: Video,
  table: Table,
  text: FileText,
};

type PreviewMode = "image" | "audio" | "video" | "pdf" | "text" | "unsupported";

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

function sourcePreviewMode(filename: string): PreviewMode {
  const ext = extensionOf(filename);
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["mp3", "wav", "m4a", "aac", "ogg"].includes(ext)) return "audio";
  if (["mp4", "mov", "webm", "mkv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (["md", "markdown", "txt", "csv", "json"].includes(ext)) return "text";
  return "unsupported";
}

function SourcePreviewDialog({
  row,
  sessionId,
  onClose,
}: {
  row: SourceRow;
  sessionId: string;
  onClose: () => void;
}) {
  const path = sourcePreviewPath(row);
  const url = buildAuthenticatedFileUrl(path, { sessionId });
  const mode = sourcePreviewMode(row.filename);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <div className="studio-pane flex h-[min(760px,90vh)] w-[min(920px,92vw)] flex-col overflow-hidden border shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
          <h3 className="min-w-0 truncate text-sm font-medium">{row.filename}</h3>
          <button type="button" className="studio-ghost-button p-2" aria-label="Close source preview" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface/40 p-4">
          {mode === "image" && <img src={url} alt={`${row.filename} source preview`} className="max-h-full max-w-full rounded-[8px] object-contain" />}
          {mode === "audio" && <audio src={url} controls className="w-full max-w-xl" />}
          {mode === "video" && <video src={url} controls className="max-h-full max-w-full rounded-[8px]" />}
          {(mode === "pdf" || mode === "text") && <iframe title={`${row.filename} source preview`} src={url} className="h-full w-full rounded-[8px] border bg-white" />}
          {mode === "unsupported" && (
            <a href={url} target="_blank" rel="noreferrer" className="studio-button-primary h-9 px-3 text-sm">
              <ExternalLink size={15} />
              Open file
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export function StudioSourcesPane({
  sessionId,
  selected,
  onToggle,
  uploaded,
  onUploaded,
  loading,
  onRenamed,
  onRemoved,
}: Props) {
  const allFiles = useAllFiles();
  const [query, setQuery] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewRow, setPreviewRow] = useState<SourceRow | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const sessionRows: SourceRow[] = allFiles
      .filter((f) => f.sessionId === sessionId)
      .map((f) => ({
        filename: f.filename,
        path: f.filePath,
        timestamp: f.timestamp,
      }));
    const seen = new Set<string>();
    return [...uploaded, ...sessionRows]
      .filter((row) => {
        if (seen.has(row.path)) return false;
        seen.add(row.path);
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [allFiles, sessionId, uploaded]);

  const trimmedQuery = query.trim().toLowerCase();
  const visible = trimmedQuery
    ? rows.filter((row) => row.filename.toLowerCase().includes(trimmedQuery))
    : rows;

  async function handleUpload(list: FileList | null) {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    setUploadError(null);
    try {
      const paths = await uploadFiles(files);
      const imported = await invokeSkillAction(sessionId, SOURCE_IMPORT_ACTION_ID, {
        paths,
      });
      if (!imported.ok) {
        const failed = imported.results?.find((result) => !result.success);
        throw new Error(failed?.output || "Source import failed");
      }
      if (imported.jobs?.length) {
        onUploaded(
          imported.jobs.map((job, index) =>
            sourceRowFromSkillActionJob(job, files[index]?.name),
          ),
        );
        return;
      }
      const importedPaths = imported.materialized_paths?.length
        ? imported.materialized_paths
        : paths;
      const now = Date.now();
      const rows = importedPaths.map((path, index) => ({
        path,
        filename: fileNameFromPath(path, files[index]?.name ?? path),
        timestamp: now,
        status: "ready" as const,
      }));
      onUploaded(rows);
      for (const row of rows) onToggle(row.path);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      // Allow re-uploading the same file after a failure.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function rowKey(row: SourceRow): string {
    return row.jobId ?? row.sourceId ?? row.path;
  }

  function beginRename(row: SourceRow) {
    setActionError(null);
    setRenamingKey(rowKey(row));
    setRenameValue(row.filename);
  }

  async function saveRename(row: SourceRow) {
    if (!row.sourceId) return;
    const title = renameValue.trim();
    if (!title) return;
    const key = rowKey(row);
    setBusyKey(key);
    setActionError(null);
    try {
      const response = await invokeSkillAction(sessionId, SOURCE_RENAME_ACTION_ID, {
        source_id: row.sourceId,
        title,
      });
      if (!response.ok) {
        const failed = response.results?.find((result) => !result.success);
        throw new Error(failed?.output || "Source rename failed");
      }
      onRenamed(row, title);
      setRenamingKey(null);
      setRenameValue("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Source rename failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function removeSource(row: SourceRow) {
    if (!row.sourceId) return;
    if (!window.confirm(`Remove source "${row.filename}"?`)) return;
    const key = rowKey(row);
    setBusyKey(key);
    setActionError(null);
    try {
      const response = await invokeSkillAction(sessionId, SOURCE_REMOVE_ACTION_ID, {
        source_id: row.sourceId,
      });
      if (!response.ok) {
        const failed = response.results?.find((result) => !result.success);
        throw new Error(failed?.output || "Source remove failed");
      }
      if (previewRow && rowKey(previewRow) === key) {
        setPreviewRow(null);
      }
      onRemoved(row);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Source remove failed");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="studio-headline text-sm">Sources</h2>
        <button
          type="button"
          className="studio-button-primary h-8 px-3 text-xs"
          onClick={() => inputRef.current?.click()}
        >
          <Plus size={14} />
          Add source
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="studio-upload-input"
          onChange={(e) => {
            void handleUpload(e.target.files);
          }}
        />
      </div>
      {uploadError && (
        <p className="shrink-0 text-xs text-red-500" role="alert">
          {uploadError}
        </p>
      )}
      {actionError && (
        <p className="shrink-0 text-xs text-red-500" role="alert">
          {actionError}
        </p>
      )}
      <div className="relative shrink-0">
        <Search
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          type="search"
          data-with-icon
          className="studio-input h-9"
          placeholder="Search project…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search sources"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="studio-empty-state text-xs">
            {rows.length === 0
              ? loading
                ? "Loading sources…"
                : "No sources yet. Upload files to add notebook sources."
              : "No sources match your search."}
          </div>
        ) : (
          <ul className="flex flex-col">
            {visible.map((row) => {
              const Icon = KIND_ICONS[sourceKind(row.filename)];
              const ready = isSourceRowReady(row);
              const statusLabel =
                row.status === "processing"
                  ? "Processing"
                  : row.status === "failed"
                    ? "Failed"
                    : row.status === "abandoned"
                      ? "Abandoned"
                      : null;
              const key = rowKey(row);
              const isRenaming = renamingKey === key;
              const isBusy = busyKey === key;
              const canManage = ready && Boolean(row.sourceId);
              return (
                <li key={row.jobId ?? row.path} className="studio-list-row">
                  {isRenaming ? (
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <Icon size={16} className="shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <input
                          className="studio-input h-8 text-sm"
                          aria-label="Rename source title"
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void saveRename(row);
                            }
                            if (event.key === "Escape") {
                              setRenamingKey(null);
                              setRenameValue("");
                            }
                          }}
                          autoFocus
                        />
                        {row.error && <p className="mt-1 truncate text-xs text-red-500">{row.error}</p>}
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-label={`Preview ${row.filename}`}
                      onClick={() => setPreviewRow(row)}
                    >
                      <Icon size={16} className="shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 truncate text-sm" title={row.filename}>
                            {row.filename}
                          </span>
                          {statusLabel && (
                            <span className="shrink-0 rounded border px-1.5 py-0.5 font-label text-[10px] uppercase tracking-[0.04em] text-muted">
                              {statusLabel}
                            </span>
                          )}
                        </div>
                        {row.error && <p className="mt-1 truncate text-xs text-red-500">{row.error}</p>}
                      </div>
                    </button>
                  )}
                  {isRenaming ? (
                    <>
                      <button type="button" className="studio-ghost-button p-1.5" aria-label="Save source rename" disabled={isBusy} onClick={() => void saveRename(row)}>
                        <Check size={14} />
                      </button>
                      <button type="button" className="studio-ghost-button p-1.5" aria-label="Cancel source rename" disabled={isBusy} onClick={() => setRenamingKey(null)}>
                        <X size={14} />
                      </button>
                    </>
                  ) : canManage ? (
                    <>
                      <button type="button" className="studio-ghost-button p-1.5" aria-label={`Rename ${row.filename}`} disabled={isBusy} onClick={() => beginRename(row)}>
                        <Pencil size={14} />
                      </button>
                      <button type="button" className="studio-ghost-button p-1.5 text-red-500" aria-label={`Remove ${row.filename}`} disabled={isBusy} onClick={() => void removeSource(row)}>
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : (
                    <Eye size={14} className="shrink-0 text-muted" aria-hidden="true" />
                  )}
                  <input
                    type="checkbox"
                    className="accent-accent h-4 w-4"
                    checked={ready && selected.includes(row.path)}
                    disabled={!ready}
                    onChange={() => {
                      if (ready) onToggle(row.path);
                    }}
                    aria-label={`Use ${row.filename} as source`}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {selected.length > 0 && (
        <p className="studio-kicker shrink-0">
          {selected.length} source{selected.length === 1 ? "" : "s"} selected for
          notebook grounding
        </p>
      )}
      {previewRow && (
        <SourcePreviewDialog row={previewRow} sessionId={sessionId} onClose={() => setPreviewRow(null)} />
      )}
    </div>
  );
}
