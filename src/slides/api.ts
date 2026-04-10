import { buildApiHeaders } from "@/api/client";
import type { ContentEntry } from "@/api/content";
import { buildFileUrl } from "@/api/files";
import { API_BASE } from "@/lib/constants";

export interface SlidesFileEntry {
  filename: string;
  path: string;
  size: number;
  modified: string;
  category: string;
  group: string;
}

export interface SlidesManifestSlide {
  index: number;
  filename: string;
  path: string;
}

export interface SlidesRenderManifest {
  version: number;
  generatedAt: string;
  slideDir: string;
  outFile: string;
  slideCount: number;
  slides: SlidesManifestSlide[];
  manifestPath: string;
}

interface ListSlidesFilesOptions {
  sessionId?: string;
}

interface WaitForSlidesScaffoldOptions {
  sessionId: string;
  slug: string;
  signal?: AbortSignal;
  attempts?: number;
  delayMs?: number;
}

export function buildSlidesSlug(title: string, projectId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = projectId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(-6) || "deck";
  return `${base || "untitled"}-${suffix}`;
}

export async function listSlidesFiles(
  dirs: string | string[],
  options: ListSlidesFilesOptions = {},
): Promise<SlidesFileEntry[]> {
  const requestedDirs = (Array.isArray(dirs) ? dirs : [dirs]).map(normalizeSlidesDir);
  const params = new URLSearchParams({
    dirs: requestedDirs.join(","),
  });
  if (options.sessionId) {
    params.set("session_id", options.sessionId);
  }
  const resp = await fetch(`${API_BASE}/api/files/list?${params.toString()}`, {
    headers: buildApiHeaders(),
    cache: "no-store",
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

export async function waitForSlidesScaffold({
  sessionId,
  slug,
  signal,
  attempts = 12,
  delayMs = 500,
}: WaitForSlidesScaffoldOptions): Promise<SlidesFileEntry[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      const files = await listSlidesFiles(`slides/${slug}`, { sessionId });
      const filenames = new Set(files.map((file) => file.filename));
      if (
        filenames.has("script.js") &&
        filenames.has("memory.md") &&
        filenames.has("changelog.md")
      ) {
        return files;
      }
    } catch (error) {
      if (attempt === attempts - 1) {
        throw error;
      }
    }

    if (attempt < attempts - 1) {
      await delay(delayMs, signal);
    }
  }

  throw new Error(`slides scaffold did not appear for ${slug}`);
}

export async function fetchSlidesManifest(
  slug: string,
  files: SlidesFileEntry[],
): Promise<SlidesRenderManifest | null> {
  const manifestPath = resolveSlidesManifestPath(slug, files);
  if (!manifestPath) return null;

  const resp = await fetch(buildFileUrl(manifestPath), {
    headers: buildApiHeaders(),
    cache: "no-store",
  });
  if (resp.status === 404) {
    return null;
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as unknown;
  return normalizeSlidesManifest(data, manifestPath);
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

function resolveSlidesManifestPath(
  slug: string,
  files: SlidesFileEntry[],
): string | null {
  const normalizedSlug = normalizeSlidesDir(slug).split("/").pop() || slug;
  const marker = `/slides/${normalizedSlug}/`;

  // Find ALL manifest.json files under this project's output/ directory.
  // Pick the most recently modified one — handles cases like output/imgs/,
  // output/imgs_5pages/, etc.
  const manifests = files.filter((file) => {
    if (file.filename !== "manifest.json") return false;
    const normalizedPath = normalizeSlidesDir(file.path);
    return normalizedPath.includes(marker) && normalizedPath.includes("/output/");
  });

  if (manifests.length === 0) {
    // Fallback: construct default path from any project file
    for (const file of files) {
      const normalizedPath = file.path.replace(/\\/g, "/");
      const markerIndex = normalizedPath.indexOf(marker);
      if (markerIndex === -1) continue;
      const projectRoot = normalizedPath
        .slice(0, markerIndex + marker.length)
        .replace(/\/$/, "");
      return `${projectRoot}/output/imgs/manifest.json`;
    }
    return null;
  }

  // Sort by modified time descending — pick the newest manifest
  manifests.sort((a, b) => {
    const aTime = new Date(a.modified || 0).getTime();
    const bTime = new Date(b.modified || 0).getTime();
    return bTime - aTime;
  });

  return manifests[0].path;
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
    const parts = dir.split("/");
    if (!(parts[0] === "slides" && parts.length === 2)) continue;

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

function normalizeSlidesManifest(
  value: unknown,
  manifestPath: string,
): SlidesRenderManifest {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const rawSlides = Array.isArray(raw.slides) ? raw.slides : [];

  return {
    version:
      typeof raw.version === "number" && Number.isFinite(raw.version)
        ? raw.version
        : 1,
    generatedAt:
      typeof raw.generated_at === "string" ? raw.generated_at : "",
    slideDir:
      typeof raw.slide_dir === "string"
        ? resolveManifestPath(raw.slide_dir, manifestPath)
        : "",
    outFile:
      typeof raw.out_file === "string"
        ? resolveManifestPath(raw.out_file, manifestPath)
        : "",
    slideCount:
      typeof raw.slide_count === "number" && Number.isFinite(raw.slide_count)
        ? raw.slide_count
        : rawSlides.length,
    slides: rawSlides
      .map((slide, position) =>
        normalizeManifestSlide(slide, position, manifestPath),
      )
      .filter((slide): slide is SlidesManifestSlide => !!slide),
    manifestPath,
  };
}

function normalizeManifestSlide(
  value: unknown,
  position: number,
  manifestPath: string,
): SlidesManifestSlide | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.path !== "string" || raw.path.length === 0) return null;
  const resolvedPath = resolveManifestPath(raw.path, manifestPath);

  return {
    index:
      typeof raw.index === "number" && Number.isFinite(raw.index)
        ? raw.index
        : position,
    filename:
      typeof raw.filename === "string" && raw.filename.length > 0
        ? raw.filename
        : fileBasename(resolvedPath),
    path: resolvedPath,
  };
}

function resolveManifestPath(path: string, manifestPath: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  if (
    normalizedPath.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedPath) ||
    /^https?:\/\//i.test(normalizedPath)
  ) {
    return normalizedPath;
  }

  const normalizedManifest = manifestPath.replace(/\\/g, "/");
  const markerIndex = normalizedManifest.indexOf("/slides/");
  if (normalizedPath.startsWith("slides/") && markerIndex !== -1) {
    const workspaceRoot = normalizedManifest.slice(0, markerIndex + 1);
    return `${workspaceRoot}${normalizedPath}`;
  }

  const manifestDir = normalizedManifest.slice(
    0,
    normalizedManifest.lastIndexOf("/") + 1,
  );
  return `${manifestDir}${normalizedPath.replace(/^\.?\//, "")}`;
}

function fileBasename(path: unknown): string {
  if (typeof path !== "string") return "";
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    function onAbort() {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    }

    function cleanup() {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
