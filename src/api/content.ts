import { request, getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";

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
}

// --- API ---

export async function fetchContent(
  filters: ContentFilters = {},
): Promise<ContentQueryResult> {
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

export async function deleteContent(id: string): Promise<void> {
  await request(`/api/my/content/${id}`, { method: "DELETE" });
}

export async function bulkDeleteContent(ids: string[]): Promise<void> {
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
    `${API_BASE}/api/files?path=${encodeURIComponent(entry.path)}`,
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
