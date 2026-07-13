/**
 * Pure helpers for Studio source grounding.
 *
 * Kept in a plain .ts module (no component exports) so the
 * react-refresh/only-export-components rule stays happy and the
 * grounding logic is unit-testable without rendering the workspace.
 */

import type { SkillActionJob, SkillActionJobStatus } from "@/api/skill-actions";

/**
 * Merge selected source paths into a turn's media list without
 * duplicates. Order: original media first, then newly selected
 * sources in selection order. Inputs are never mutated.
 */
export function mergeSourceMedia(
  media: readonly string[],
  selected: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of [...media, ...selected]) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

export const SOURCE_IMPORT_ACTION_ID = "source.import";
export const SOURCE_LIST_ACTION_ID = "source.list";
export const SOURCE_RENAME_ACTION_ID = "source.rename";
export const SOURCE_REMOVE_ACTION_ID = "source.remove";

export const SOURCE_UPLOAD_EXTENSIONS = [
  ".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm",
  ".docx", ".pptx", ".xlsx", ".xlsm", ".pdf",
  ".jpg", ".jpeg", ".png", ".webp", ".gif",
  ".mp3", ".wav", ".m4a", ".aac", ".ogg",
  ".mp4", ".mov", ".webm", ".mkv",
] as const;
export const SOURCE_UPLOAD_ACCEPT = SOURCE_UPLOAD_EXTENSIONS.join(",");

export type SourceRowStatus = "processing" | "ready" | "failed" | "abandoned";

/**
 * A source row in the Sources pane. Rows can come from ordinary session
 * files, synchronous imports, or background skill-action jobs.
 */
export interface SourceRow {
  filename: string;
  originalFilename?: string;
  path: string;
  timestamp: number;
  status?: SourceRowStatus;
  jobId?: string;
  batchId?: string;
  sourceId?: string;
  error?: string;
  inputPath?: string;
  sourcePath?: string;
  materializedPath?: string;
  previewPath?: string;
  mediaType?: string;
  sourceType?: string;
  metadataPath?: string;
  chunksPath?: string;
  summaryPath?: string;
  warnings?: string[];
  provenance?: Record<string, unknown>;
  retryInput?: Record<string, unknown>;
}

export function isSourceRowReady(row: SourceRow): boolean {
  return (row.status ?? "ready") === "ready";
}

/** Coarse file-type buckets used to pick a list-row icon. */
export type SourceKind = "image" | "audio" | "video" | "table" | "text";

const KIND_BY_EXTENSION: Record<string, SourceKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  mp4: "video",
  mov: "video",
  webm: "video",
  csv: "table",
  xlsx: "table",
  xlsm: "table",
  pdf: "text",
  docx: "text",
  pptx: "text",
};

/** Classify a filename by extension; anything unknown is "text". */
export function sourceKind(filename: string): SourceKind {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return "text";
  const ext = filename.slice(dot + 1).toLowerCase();
  return KIND_BY_EXTENSION[ext] ?? "text";
}

export function fileNameFromPath(path: string, fallback: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? fallback;
}

function sourceStatusFromJob(status: SkillActionJobStatus): SourceRowStatus {
  switch (status) {
    case "succeeded":
      return "ready";
    case "failed":
      return "failed";
    case "abandoned":
      return "abandoned";
    case "queued":
    case "running":
      return "processing";
  }
}

function timestampFromJob(job: SkillActionJob): number {
  const parsed = Date.parse(job.updated_at || job.created_at);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function sourceRowFromSkillActionJob(
  job: SkillActionJob,
  fallbackFilename?: string,
): SourceRow {
  const status = sourceStatusFromJob(job.status);
  const path =
    status === "ready"
      ? (job.source_path ?? job.materialized_path ?? job.input_path ?? job.job_id)
      : (job.input_path ?? job.materialized_path ?? job.source_path ?? job.job_id);
  const filename =
    job.filename ??
    fileNameFromPath(
      job.input_path ?? job.source_path ?? job.materialized_path ?? job.job_id,
      fallbackFilename ?? job.job_id,
    );

  return {
    filename,
    path,
    timestamp: timestampFromJob(job),
    status,
    jobId: job.job_id,
    batchId: job.batch_id,
    sourceId: job.source_id,
    error: job.error ?? (status === "failed" ? job.output : undefined),
    inputPath: job.input_path,
    sourcePath: job.source_path,
    materializedPath: job.materialized_path,
    previewPath: job.materialized_path ?? job.input_path,
  };
}

export function sourcePreviewPath(row: SourceRow): string {
  return row.previewPath ?? row.materializedPath ?? row.inputPath ?? row.path;
}

export function mergeSourceRows(
  existing: readonly SourceRow[],
  incoming: readonly SourceRow[],
): SourceRow[] {
  const rows = [...existing];
  for (const next of incoming) {
    const index = rows.findIndex(
      (row) =>
        (next.jobId && row.jobId === next.jobId) || row.path === next.path,
    );
    if (index === -1) {
      rows.push(next);
    } else if (next.timestamp >= rows[index].timestamp) {
      rows[index] = { ...rows[index], ...next };
    }
  }
  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Tiny relative-time formatter for asset rows. Falls back to a locale
 * date for anything older than a week. `now` is injectable for tests.
 */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const diffSec = Math.floor(Math.max(0, now - ms) / 1000);
  if (diffSec < 60) return "just now";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}
