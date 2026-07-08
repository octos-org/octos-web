/**
 * Pure helpers for Studio source grounding.
 *
 * Kept in a plain .ts module (no component exports) so the
 * react-refresh/only-export-components rule stays happy and the
 * grounding logic is unit-testable without rendering the workspace.
 */

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

/**
 * A source row in the Sources pane. Uploaded sources exist only on the
 * client (the upload endpoint returns bare server paths), so the state
 * lives in the workspace — not the pane — and survives pane toggles.
 */
export interface SourceRow {
  filename: string;
  path: string;
  timestamp: number;
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
};

/** Classify a filename by extension; anything unknown is "text". */
export function sourceKind(filename: string): SourceKind {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return "text";
  const ext = filename.slice(dot + 1).toLowerCase();
  return KIND_BY_EXTENSION[ext] ?? "text";
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
