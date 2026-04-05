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
  const requestedDirs = (Array.isArray(dirs) ? dirs : [dirs]).map(normalizeSlidesDir);
  const params = new URLSearchParams({
    dirs: requestedDirs.join(","),
  });
  const resp = await fetch(`${API_BASE}/api/files/list?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const files = (await resp.json()) as SlidesFileEntry[];
  const filtered = files.filter((file) =>
    requestedDirs.some((dir) => fileMatchesSlidesDir(file, dir)),
  );
  return ensureCoreSlidesFiles(filtered, requestedDirs);
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

function normalizeSlidesDir(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function fileMatchesSlidesDir(
  file: Pick<SlidesFileEntry, "path" | "group">,
  dir: string,
): boolean {
  const normalizedDir = normalizeSlidesDir(dir);
  const normalizedPath = normalizeSlidesDir(file.path);
  const normalizedGroup = normalizeSlidesDir(file.group);

  if (normalizedGroup === normalizedDir || normalizedGroup.startsWith(`${normalizedDir}/`)) {
    return true;
  }

  if (normalizedPath === normalizedDir || normalizedPath.endsWith(`/${normalizedDir}`)) {
    return true;
  }

  return normalizedPath.includes(`/${normalizedDir}/`);
}

function ensureCoreSlidesFiles(
  files: SlidesFileEntry[],
  requestedDirs: string[],
): SlidesFileEntry[] {
  const nextFiles = [...files];
  const seenPaths = new Set(nextFiles.map((file) => normalizeSlidesDir(file.path)));

  for (const dir of requestedDirs) {
    if (!dir.startsWith("slides/")) continue;

    const dirFiles = nextFiles.filter((file) => fileMatchesSlidesDir(file, dir));
    const rootFile =
      dirFiles.find((file) => normalizeSlidesDir(file.group) === dir) ??
      dirFiles[0];
    if (!rootFile) continue;

    const normalizedRootPath = rootFile.path.replace(/\\/g, "/");
    const projectRoot = normalizedRootPath.slice(
      0,
      normalizedRootPath.lastIndexOf("/"),
    );
    if (!projectRoot) continue;

    for (const filename of ["script.js", "memory.md", "changelog.md"]) {
      const path = `${projectRoot}/${filename}`;
      const normalizedPath = normalizeSlidesDir(path);
      if (seenPaths.has(normalizedPath)) continue;

      nextFiles.push({
        filename,
        path,
        size: 0,
        modified: rootFile.modified,
        category: /\.(md|markdown|txt|js|ts|tsx|jsx|json)$/i.test(filename)
          ? "report"
          : rootFile.category,
        group: dir,
      });
      seenPaths.add(normalizedPath);
    }
  }

  return nextFiles;
}
