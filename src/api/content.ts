import { request, getSelectedProfileId, getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";
import { buildFileUrl } from "@/api/files";
import {
  BridgeRpcError,
  BridgeStoppedError,
  BridgeTimeoutError,
  METHODS,
} from "@/runtime/ui-protocol-bridge";
import { getAnyConnectedBridge } from "@/runtime/ui-protocol-runtime";
import { isAuxRestToWsV1Enabled } from "@/lib/feature-flags";

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

// ---------------------------------------------------------------------------
// M12 Phase D-2 wrapper helpers — see header in `src/api/sessions.ts`.
// ---------------------------------------------------------------------------

function shouldUseWs(): boolean {
  if (!isAuxRestToWsV1Enabled()) return false;
  return getAnyConnectedBridge() !== null;
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
  // Server-side `ContentListParams.filters` is a free-form JSON object
  // mirrored 1:1 onto the existing REST `ContentQuery` shape (snake_case
  // server-side; the UI passes camelCase `sessionId`, which the REST
  // query param flattener has historically not used — the REST `GET`
  // accepts no sessionId at all). For WS we pass through the keys the
  // server actually consumes.
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

// ---------------------------------------------------------------------------
// content/list — `GET /api/my/content`
// ---------------------------------------------------------------------------

export async function fetchContent(
  filters: ContentFilters = {},
): Promise<ContentQueryResult> {
  if (shouldUseWs()) {
    return callAuxWs<ContentQueryResult>(METHODS.CONTENT_LIST, {
      filters: filtersToWsParams(filters),
    });
  }
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.search) params.set("search", filters.search);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.sort) params.set("sort", filters.sort);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.offset) params.set("offset", String(filters.offset));

  const qs = params.toString();
  return request<ContentQueryResult>(
    `/api/my/content${qs ? `?${qs}` : ""}`,
  );
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

// ---------------------------------------------------------------------------
// content/delete — `DELETE /api/my/content/:id`
// ---------------------------------------------------------------------------

export async function deleteContent(id: string): Promise<void> {
  if (shouldUseWs()) {
    await callAuxWs<{ deleted: boolean }>(METHODS.CONTENT_DELETE, { id });
    return;
  }
  await request(`/api/my/content/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// content/bulk_delete — `POST /api/my/content/bulk-delete`
// ---------------------------------------------------------------------------

export async function bulkDeleteContent(ids: string[]): Promise<void> {
  if (shouldUseWs()) {
    await callAuxWs<{ deleted: number }>(METHODS.CONTENT_BULK_DELETE, {
      ids,
    });
    return;
  }
  await request("/api/my/content/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
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
