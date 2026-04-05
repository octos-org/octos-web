import { getToken } from "@/api/client";
import type { ContentEntry } from "@/api/content";
import { API_BASE } from "@/lib/constants";

export interface SlidesFileEntry {
  filename: string;
  path: string;
  size: number;
  modified: string;
  category: string;
  group: string;
}

export function slugifySlidesTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled-deck";
}

export async function listSlidesFiles(
  dirs: string | string[],
): Promise<SlidesFileEntry[]> {
  const token = getToken();
  const params = new URLSearchParams({
    dirs: Array.isArray(dirs) ? dirs.join(",") : dirs,
  });
  const resp = await fetch(`${API_BASE}/api/files/list?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return resp.json();
}

export function slidesFileToContentEntry(file: SlidesFileEntry): ContentEntry {
  return {
    id: file.path,
    filename: file.filename,
    path: file.path,
    category: inferContentCategory(file),
    size_bytes: file.size,
    created_at: file.modified,
    thumbnail_path: null,
    session_id: null,
    tool_name: null,
    caption: file.group || null,
  };
}

export function inferContentCategory(
  file: Pick<SlidesFileEntry, "filename" | "category">,
): ContentEntry["category"] {
  if (file.category === "slides") return "slides";
  if (file.category === "image") return "image";
  if (file.category === "video") return "video";
  if (file.category === "audio") return "audio";
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.filename)) return "image";
  if (/\.(pptx|key)$/i.test(file.filename)) return "slides";
  if (/\.(mp4|webm|mov)$/i.test(file.filename)) return "video";
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(file.filename)) return "audio";
  if (/\.(md|markdown|txt|js|ts|tsx|jsx|json)$/i.test(file.filename)) return "report";
  return "other";
}

export function inferGroupName(
  file: Pick<SlidesFileEntry, "path" | "group">,
  slug: string,
): string {
  if (file.group) return file.group;
  const marker = `/slides/${slug}/`;
  const normalized = file.path.replace(/\\/g, "/");
  const idx = normalized.indexOf(marker);
  if (idx === -1) return "files";
  const relative = normalized.slice(idx + marker.length);
  const parts = relative.split("/").slice(0, -1);
  return parts.join("/") || "root";
}
