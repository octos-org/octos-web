import { useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { FileText, Image, Music, Plus, Search, Table, Video } from "lucide-react";

import { uploadFiles } from "@/api/chat";
import { invokeSkillAction } from "@/api/skill-actions";
import { useAllFiles } from "@/store/file-store";

import { sourceKind, type SourceKind, type SourceRow } from "./source-media";

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

const SOURCE_IMPORT_ACTION_ID = "source.import";

function fileNameFromPath(path: string, fallback: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? fallback;
}

export function StudioSourcesPane({
  sessionId,
  selected,
  onToggle,
  uploaded,
  onUploaded,
  loading,
}: Props) {
  const allFiles = useAllFiles();
  const [query, setQuery] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
      const importedPaths = imported.materialized_paths?.length
        ? imported.materialized_paths
        : paths;
      const now = Date.now();
      const rows = importedPaths.map((path, index) => ({
        path,
        filename: fileNameFromPath(path, files[index]?.name ?? path),
        timestamp: now,
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
              return (
                <li key={row.path} className="studio-list-row">
                  <Icon size={16} className="shrink-0 text-muted" />
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    title={row.filename}
                  >
                    {row.filename}
                  </span>
                  <input
                    type="checkbox"
                    className="accent-accent h-4 w-4"
                    checked={selected.includes(row.path)}
                    onChange={() => onToggle(row.path)}
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
