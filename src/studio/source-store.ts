import {
  invokeSkillAction,
  type SkillActionInvokeResponse,
  type SkillActionJob,
} from "@/api/skill-actions";

import { sourceRowFromSkillActionJob, type SourceRow } from "./source-media";

interface SourceCatalogItem {
  id: string;
  display_name?: string;
  title?: string;
  kind?: string;
  media_type?: string;
  original_path: string;
  preview_path?: string;
  source_path: string;
  metadata_path?: string;
  chunks_path?: string;
  created_at: string;
  updated_at: string;
  retry_input?: Record<string, unknown> | null;
}

function isCatalogItem(value: unknown): value is SourceCatalogItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.original_path === "string" &&
    typeof item.source_path === "string" &&
    typeof item.created_at === "string" &&
    typeof item.updated_at === "string"
  );
}

export function parseSourceCatalog(response: SkillActionInvokeResponse): SourceRow[] {
  const metadata = response.results?.find(
    (result) => result.success && result.structured_metadata,
  )?.structured_metadata;
  if (!metadata || typeof metadata !== "object") return [];
  const sources = (metadata as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  return sources.filter(isCatalogItem).map((source) => ({
    sourceId: source.id,
    filename: source.display_name || source.title || source.id,
    path: source.source_path,
    sourcePath: source.source_path,
    inputPath: source.original_path,
    previewPath: source.preview_path || source.original_path || source.source_path,
    timestamp: Date.parse(source.updated_at) || Date.parse(source.created_at) || 0,
    status: "ready" as const,
    mediaType: source.media_type,
    retryInput: source.retry_input ?? undefined,
  }));
}

export async function loadSourceCatalog(sessionId: string): Promise<SourceRow[]> {
  const response = await invokeSkillAction(sessionId, "source.list", {});
  if (!response.ok) throw new Error("Source catalog is unavailable");
  return parseSourceCatalog(response);
}

export function reconcileSourceRows(
  catalog: readonly SourceRow[],
  jobs: readonly SkillActionJob[],
): SourceRow[] {
  const transient = jobs
    .filter((job) => job.action_id === "source.import" && job.status !== "succeeded")
    .map((job) => sourceRowFromSkillActionJob(job));
  return [...catalog, ...transient];
}
