import { getSelectedProfileId, getToken } from "@/api/client";
import { API_BASE, CONTENT_BULK_DELETE_BATCH_SIZE } from "@/lib/constants";
import { buildFileUrl } from "@/api/files";
import {
  BridgeRpcError,
  BridgeStoppedError,
  BridgeTimeoutError,
  METHODS,
} from "@/runtime/ui-protocol-bridge";
import { getAnyConnectedBridge } from "@/runtime/ui-protocol-runtime";

// --- Types ---

export interface ContentEntry {
  id: string;
  filename: string;
  path: string;
  category: "report" | "audio" | "slides" | "image" | "video" | "other";
  size_bytes: number;
  created_at: string;
  thumbnail_path: string | null;
  session_id: string | null;
  tool_name: string | null;
  caption: string | null;
}

export interface ContentQueryResult {
  entries: ContentEntry[];
  total: number;
}

export interface ContentFilters {
  category?: string;
  search?: string;
  from?: string;
  to?: string;
  sort?: "newest" | "oldest" | "name" | "size";
  limit?: number;
  offset?: number;
  sessionId?: string;
}

function translateBridgeError(err: unknown): Error {
  if (err instanceof BridgeRpcError) return new Error(err.message);
  if (err instanceof BridgeTimeoutError) return new Error(err.message);
  if (err instanceof BridgeStoppedError) return new Error(err.message);
  if (err instanceof Error) return err;
  return new Error(String(err));
}

async function callAuxWs<T>(method: string, params: unknown): Promise<T> {
  const bridge = getAnyConnectedBridge();
  if (!bridge) {
    throw new Error("ui-protocol-bridge: no connected bridge for " + method);
  }
  try {
    return await bridge.callMethod<T>(method, params);
  } catch (err) {
    throw translateBridgeError(err);
  }
}

// --- API ---

function filtersToWsParams(filters: ContentFilters): Record<string, unknown> {
  const filterObj: Record<string, unknown> = {};
  if (filters.category) filterObj.category = filters.category;
  if (filters.search) filterObj.search = filters.search;
  if (filters.from) filterObj.from = filters.from;
  if (filters.to) filterObj.to = filters.to;
  if (filters.sort) filterObj.sort = filters.sort;
  if (filters.limit !== undefined) filterObj.limit = filters.limit;
  if (filters.offset !== undefined) filterObj.offset = filters.offset;
  if (filters.sessionId) filterObj.session_id = filters.sessionId;
  return filterObj;
}

export async function fetchContent(
  filters: ContentFilters = {},
): Promise<ContentQueryResult> {
  return callAuxWs<ContentQueryResult>(METHODS.CONTENT_LIST, {
    filters: filtersToWsParams(filters),
  });
}

export function matchesContentSession(
  entry: Pick<ContentEntry, "session_id" | "path">,
  sessionId?: string,
): boolean {
  if (!sessionId) return true;
  if (entry.session_id === sessionId) return true;

  const profileId = getSelectedProfileId();
  const candidates = [profileId ? `${profileId}:api:${sessionId}` : `api:${sessionId}`];

  const rawPath = entry.path || "";
  let decodedPath = rawPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    // Keep the raw path when decoding fails.
  }

  return candidates.some((candidate) => {
    const encoded = encodeURIComponent(candidate);
    return (
      rawPath.includes(`/${encoded}/`) ||
      rawPath.includes(encoded) ||
      decodedPath.includes(`/${candidate}/`) ||
      decodedPath.includes(candidate)
    );
  });
}

export async function deleteContent(id: string): Promise<void> {
  await callAuxWs<{ deleted: boolean }>(METHODS.CONTENT_DELETE, { id });
}

export interface BulkDeleteResult {
  deleted_count: number;
  failed_ids: string[];
}

/**
 * Delete a batch of content entries, chunked client-side to
 * `CONTENT_BULK_DELETE_BATCH_SIZE` (256) per request.
 *
 * The server-side WS dispatcher caps `content/bulk_delete` at 256 IDs.
 *
 * Returns a `BulkDeleteResult` so callers can surface partial-failure
 * semantics — earlier chunks may have committed even if a later one
 * threw. The legacy `void` return is preserved at the call sites that
 * don't care via discarding.
 */
export async function bulkDeleteContent(
  ids: string[],
): Promise<BulkDeleteResult> {
  if (ids.length === 0) {
    return { deleted_count: 0, failed_ids: [] };
  }

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CONTENT_BULK_DELETE_BATCH_SIZE) {
    chunks.push(ids.slice(i, i + CONTENT_BULK_DELETE_BATCH_SIZE));
  }

  let deletedCount = 0;
  const failedIds: string[] = [];

  for (const chunk of chunks) {
    try {
      const out = await callAuxWs<{ deleted?: number }>(
        METHODS.CONTENT_BULK_DELETE,
        { ids: chunk },
      );
      deletedCount += out?.deleted ?? chunk.length;
    } catch (err) {
      // Aggregate failures so partially-successful batches still report
      // useful progress to the caller. Don't rethrow mid-loop: chunks
      // after a failure are also recorded as failed to preserve the
      // caller's view of "these IDs were not deleted".
      failedIds.push(...chunk);
      console.warn("[octos] bulkDeleteContent chunk failed", err);
    }
  }

  return { deleted_count: deletedCount, failed_ids: failedIds };
}

export function thumbnailUrl(id: string): string {
  return `${API_BASE}/api/my/content/${id}/thumbnail`;
}

/** Secure download with auth header. */
export async function downloadContent(entry: ContentEntry): Promise<void> {
  const token = getToken();
  const resp = await fetch(
    buildFileUrl(entry.path),
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  );
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = entry.filename;
  a.click();
  URL.revokeObjectURL(url);
}
