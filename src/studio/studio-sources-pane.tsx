import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Check,
  Eye,
  FileText,
  Image,
  Music,
  Pencil,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Table,
  Trash2,
  Video,
  X,
} from "lucide-react";

import { uploadFiles } from "@/api/chat";
import { invokeSkillAction } from "@/api/skill-actions";

import {
  SOURCE_IMPORT_ACTION_ID,
  SOURCE_UPLOAD_ACCEPT,
  SOURCE_REMOVE_ACTION_ID,
  SOURCE_RENAME_ACTION_ID,
  isSourceRowReady,
  sourceRowMatchesPath,
  sourceKind,
  sourceRowFromSkillActionJob,
  type SourceKind,
  type SourceRow,
} from "./source-media";
import { StudioSourcePreview } from "./studio-source-preview";
import type { CitationTarget } from "./structured-asset-viewers";

interface Props {
  sessionId: string;
  previewKey: string | null;
  onPreviewKeyChange: (key: string | null) => void;
  /** Server file paths currently selected as grounding sources. */
  selected: string[];
  onToggle: (row: SourceRow) => void;
  /**
   * Uploaded-source rows live in the workspace (not here) so toggling
   * the pane closed cannot orphan still-selected uploads.
   */
  uploaded: SourceRow[];
  onUploaded: (rows: SourceRow[]) => void;
  onRenamed: (row: SourceRow, title: string) => void;
  onRemoved: (row: SourceRow) => void;
  onCatalogChanged: () => void;
  /** True while the initial session file listing is in flight. */
  loading: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  listScrollTop: number;
  onListScrollTopChange: (scrollTop: number) => void;
  citationTarget?: CitationTarget | null;
  onCitationTargetClear?: () => void;
}

const KIND_ICONS: Record<SourceKind, LucideIcon> = {
  image: Image,
  audio: Music,
  video: Video,
  table: Table,
  text: FileText,
};

function sourceRowIdentityKeys(row: SourceRow): string[] {
  const keys = [
    row.jobId ? `job:${row.jobId}` : null,
    row.sourceId ? `source:${row.sourceId}` : null,
    row.path ? `path:${row.path}` : null,
    row.sourcePath ? `path:${row.sourcePath}` : null,
    row.inputPath ? `path:${row.inputPath}` : null,
    row.materializedPath ? `path:${row.materializedPath}` : null,
  ].filter((key): key is string => Boolean(key));
  return Array.from(new Set(keys));
}

function SourceActionsMenu({
  row,
  busy,
  canRename,
  canRemoveSource,
  canRetry,
  onPreview,
  onRename,
  onRemoveSource,
  onRetry,
  onDismiss,
}: {
  row: SourceRow;
  busy: boolean;
  canRename: boolean;
  canRemoveSource: boolean;
  canRetry: boolean;
  onPreview: () => void;
  onRename: () => void;
  onRemoveSource: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector("button")?.focus();
    function closeIfOutside(target: EventTarget | null) {
      if (rootRef.current && !rootRef.current.contains(target as Node)) {
        setOpen(false);
      }
    }
    function onDocPointerDown(event: MouseEvent) {
      closeIfOutside(event.target);
    }
    function onDocFocusIn(event: FocusEvent) {
      closeIfOutside(event.target);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        );
        if (items.length === 0) return;
        event.preventDefault();
        const index = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(index + delta + items.length) % items.length]?.focus();
      }
    }
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("focusin", onDocFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("focusin", onDocFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="studio-ghost-button p-1.5"
        aria-label={`Source actions for ${row.filename}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          ref={menuRef}
          className="studio-menu min-w-[10rem]"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="studio-menu-item"
            onClick={() => {
              onPreview();
              setOpen(false);
            }}
          >
            <Eye size={14} aria-hidden="true" />
            Preview
          </button>
          {canRename && (
            <button
              type="button"
              role="menuitem"
              className="studio-menu-item"
              onClick={() => {
                onRename();
                setOpen(false);
              }}
            >
              <Pencil size={14} aria-hidden="true" />
              Rename source
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              role="menuitem"
              className="studio-menu-item"
              onClick={() => {
                onRetry();
                setOpen(false);
              }}
            >
              <RotateCcw size={14} aria-hidden="true" />
              Retry import
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={`studio-menu-item ${canRemoveSource ? "text-red-500" : ""}`}
            onClick={() => {
              if (canRemoveSource) {
                onRemoveSource();
              } else {
                onDismiss();
              }
              setOpen(false);
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            {canRemoveSource ? "Remove source" : "Remove from list"}
          </button>
        </div>
      )}
    </div>
  );
}

export function StudioSourcesPane({
  sessionId,
  previewKey,
  onPreviewKeyChange,
  selected,
  onToggle,
  uploaded,
  onUploaded,
  loading,
  onRenamed,
  onRemoved,
  onCatalogChanged,
  query,
  onQueryChange,
  listScrollTop,
  onListScrollTopChange,
  citationTarget,
  onCitationTargetClear,
}: Props) {
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previewTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const lastPreviewTriggerKey = useRef<string | null>(null);
  const [restoreFocusKey, setRestoreFocusKey] = useState<string | null>(null);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    return uploaded
      .filter((row) => {
        if (seen.has(row.path)) return false;
        seen.add(row.path);
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [uploaded]);

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
      onCatalogChanged();
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

  const previewRow = previewKey
    ? rows.find((row) => rowKey(row) === previewKey) ?? null
    : null;

  function openPreview(key: string) {
    lastPreviewTriggerKey.current = key;
    onPreviewKeyChange(key);
  }

  function closePreview() {
    onCitationTargetClear?.();
    setRestoreFocusKey(
      previewRow ? rowKey(previewRow) : lastPreviewTriggerKey.current,
    );
    onPreviewKeyChange(null);
  }

  useEffect(() => {
    if (previewRow || !restoreFocusKey) return;
    const trigger = previewTriggerRefs.current.get(restoreFocusKey);
    if (trigger) {
      trigger.focus();
      setRestoreFocusKey(null);
    }
  }, [previewRow, restoreFocusKey]);

  useEffect(() => {
    if (!previewRow && listRef.current) listRef.current.scrollTop = listScrollTop;
  }, [listScrollTop, previewRow]);

  function dismissSourceRow(row: SourceRow) {
    setActionError(null);
    if (
      previewRow &&
      sourceRowIdentityKeys(previewRow).some((key) =>
        sourceRowIdentityKeys(row).includes(key),
      )
    ) {
      onPreviewKeyChange(null);
    }
    onRemoved(row);
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
      onCatalogChanged();
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
      dismissSourceRow(row);
      onCatalogChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Source remove failed");
    } finally {
      setBusyKey(null);
    }
  }

  async function retrySource(row: SourceRow) {
    const retryPath = row.materializedPath ?? row.inputPath;
    if (!retryPath) {
      setActionError("Original upload is no longer available; upload it again.");
      return;
    }
    const key = rowKey(row);
    setBusyKey(key);
    setActionError(null);
    try {
      const response = await invokeSkillAction(sessionId, SOURCE_IMPORT_ACTION_ID, {
        paths: [retryPath],
      });
      if (!response.ok) {
        const failed = response.results?.find((result) => !result.success);
        throw new Error(failed?.output || "Source retry failed");
      }
      if (response.jobs?.length) {
        onUploaded(
          response.jobs.map((job) => sourceRowFromSkillActionJob(job, row.filename)),
        );
      } else {
        onCatalogChanged();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Source retry failed");
    } finally {
      setBusyKey(null);
    }
  }

  if (previewRow) {
    return (
      <StudioSourcePreview
        key={rowKey(previewRow)}
        row={previewRow}
        sessionId={sessionId}
        onBack={closePreview}
        citationTarget={citationTarget}
      />
    );
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
          accept={SOURCE_UPLOAD_ACCEPT}
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
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label="Search sources"
        />
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => onListScrollTopChange(event.currentTarget.scrollTop)}
      >
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
              const Icon = KIND_ICONS[sourceKind(row.originalFilename ?? row.filename)];
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
              const canManageSource = ready && Boolean(row.sourceId);
              const selectable = ready && Boolean(row.sourceId);
              const isSelected = selectable
                && selected.some((path) => sourceRowMatchesPath(row, path));
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
                      ref={(node) => {
                        if (node) previewTriggerRefs.current.set(key, node);
                        else previewTriggerRefs.current.delete(key);
                      }}
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-label={`Preview ${row.filename}`}
                      onClick={() => openPreview(key)}
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
                  ) : (
                    <SourceActionsMenu
                      row={row}
                      busy={isBusy}
                      canRename={canManageSource}
                      canRemoveSource={canManageSource}
                      canRetry={
                        row.status === "failed" || row.status === "abandoned"
                      }
                      onPreview={() => openPreview(key)}
                      onRename={() => beginRename(row)}
                      onRemoveSource={() => {
                        void removeSource(row);
                      }}
                      onRetry={() => {
                        void retrySource(row);
                      }}
                      onDismiss={() => dismissSourceRow(row)}
                    />
                  )}
                  <input
                    type="checkbox"
                    className="accent-accent h-4 w-4"
                    checked={isSelected}
                    disabled={!selectable}
                    onChange={() => {
                      if (selectable) onToggle(row);
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
    </div>
  );
}
