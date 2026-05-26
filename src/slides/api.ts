import { buildApiHeaders } from "@/api/client";
import type { ContentEntry } from "@/api/content";
import { buildFileUrl } from "@/api/files";
// The slides workspace-contract view (slug presence, ready/dirty
// flags, turn-end + completion checks, artifact globs) routes
// through the wrappers in `src/api/sessions.ts`.
// `getSessionWorkspaceContract` calls the WS `session/workspace.get`
// method; `getSessionFiles` and `listSessions` ride the same WS
// transport. The legacy REST fallbacks were retired in M12 Phase D-5.
import {
  getSessionFiles,
  getSessionWorkspaceContract,
  listSessions,
  type SessionWorkspaceContractInfo,
} from "@/api/sessions";
import { API_BASE } from "@/lib/constants";
import type { Slide, SlidesProject } from "./types";

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

export type SlidesWorkspaceContract = SessionWorkspaceContractInfo;

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
  const suffix =
    projectId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(-6) || "deck";
  return `${base || "untitled"}-${suffix}`;
}

export async function listSlidesFiles(
  dirs: string | string[],
  options: ListSlidesFilesOptions = {},
): Promise<SlidesFileEntry[]> {
  const { filtered, requestedDirs } = await fetchSlidesFiles(dirs, options);
  return ensureCoreSlidesFiles(filtered, requestedDirs);
}

// Codex round-3 BLOCK D.a: artifact-presence checks (e.g. the
// scaffold poller) must NOT route through `ensureCoreSlidesFiles`,
// which synthesizes zero-byte placeholders for the core trio
// (script.js / memory.md / changelog.md) whenever ANY file lives
// under `slides/<slug>`. The synthesizer makes a "do all three exist"
// check trivially true, masking real scaffold failures. The raw API
// returns only what the server actually saw on disk.
export async function listSlidesFilesRaw(
  dirs: string | string[],
  options: ListSlidesFilesOptions = {},
): Promise<SlidesFileEntry[]> {
  const { filtered } = await fetchSlidesFiles(dirs, options);
  return filtered;
}

async function fetchSlidesFiles(
  dirs: string | string[],
  options: ListSlidesFilesOptions,
): Promise<{ filtered: SlidesFileEntry[]; requestedDirs: string[] }> {
  const requestedDirs = (Array.isArray(dirs) ? dirs : [dirs]).map(
    normalizeSlidesDir,
  );
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
  return { filtered, requestedDirs };
}

export async function waitForSlidesScaffold({
  sessionId,
  slug,
  signal,
  attempts = 12,
  delayMs = 500,
}: WaitForSlidesScaffoldOptions): Promise<SlidesFileEntry[]> {
  // Codex round-4 BLOCK: `file.path` is an opaque server-issued
  // handle (`pf/<base64>/<basename>`), so matching it against
  // `slides/<slug>/<name>` never succeeds and every scaffold would
  // time out. The workspace-relative directory lives on `file.group`
  // and the basename on `file.filename` — check those instead.
  // Round-3 BLOCK D.a still stands: skip `ensureCoreSlidesFiles` so
  // the synthesizer doesn't fake the trio on a partial scaffold.
  const expectedGroup = normalizeSlidesDir(`slides/${slug}`);
  const expectedFilenames = ["script.js", "memory.md", "changelog.md"];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      const files = await listSlidesFilesRaw(`slides/${slug}`, { sessionId });
      const present = new Set(
        files
          .filter((file) => normalizeSlidesDir(file.group) === expectedGroup)
          .map((file) => file.filename),
      );
      const haveAll = expectedFilenames.every((name) => present.has(name));
      if (haveAll) {
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
  if (manifestPath) {
    const resp = await fetch(buildFileUrl(manifestPath), {
      headers: buildApiHeaders(),
      cache: "no-store",
    });
    if (resp.ok) {
      const data = (await resp.json()) as unknown;
      return normalizeSlidesManifest(data, manifestPath, files);
    }
    if (resp.status !== 404) {
      throw new Error(`HTTP ${resp.status}`);
    }
    // 404 falls through to the synthesizer below
  }
  // mofa-slides 0.4.0 stopped emitting `manifest.json` and now writes
  // images directly to `skill-output/slides/<slug>/output/slide-NN.png`.
  // Synthesize a manifest from those filenames so the center-panel
  // preview keeps working until the plugin restores the explicit index.
  return synthesizeManifestFromImages(slug, files);
}

function synthesizeManifestFromImages(
  slug: string,
  files: SlidesFileEntry[],
): SlidesRenderManifest | null {
  // Match `slide-NN.png` (final composite). DELIBERATELY excludes
  // `slide-NN-ref.png` — the reference images from the image-gen API,
  // not the composited slide. Sort by NN so playback order matches the
  // deck order even if the listing endpoint returns paths out of order.
  const slideRe = /^slide-(\d+)\.png$/i;
  const expectedOutput = normalizeSlidesDir(
    `skill-output/slides/${slug}/output`,
  );
  const matches: { index: number; file: SlidesFileEntry }[] = [];
  for (const file of files) {
    const group = normalizeSlidesDir(file.group);
    if (group !== expectedOutput && !group.startsWith(`${expectedOutput}/`)) {
      continue;
    }
    const m = file.filename.match(slideRe);
    if (!m) continue;
    matches.push({ index: Number.parseInt(m[1], 10) - 1, file });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.index - b.index);
  // Deterministic stamp: derive from the newest matched file's
  // mtime+size so a same-path re-generation (PNG overwrite) flips the
  // value, but an idle poll over unchanged files returns the same
  // string. Pre-fix this was `new Date().toISOString()` which churned
  // on every call and made `pollSlideImages`'s change-detection trip
  // every cycle regardless of disk state. Codex MAJOR (PR #142).
  let newestMtime = "";
  let totalSize = 0;
  for (const { file } of matches) {
    totalSize += file.size;
    if (file.modified && file.modified > newestMtime) {
      newestMtime = file.modified;
    }
  }
  return {
    version: 0,
    generatedAt: `${newestMtime || "0"}|${totalSize}`,
    slideDir: expectedOutput,
    outFile: "",
    slideCount: matches.length,
    slides: matches.map(({ index, file }) => ({
      index,
      filename: file.filename,
      path: file.path,
    })),
    manifestPath: "",
  };
}

export async function hydrateSlidesProjectFromSession(
  sessionId: string,
): Promise<SlidesProject | null> {
  const direct = await hydrateSlidesProjectCandidate(
    sessionId,
    baseSessionId(sessionId),
  );
  if (direct) return direct;

  const sessionIds = await listSessions()
    .then((sessions) => sessions.map((session) => session.id))
    .catch(() => []);
  for (const candidate of alternateSlidesSessionCandidates(
    sessionId,
    sessionIds,
  )) {
    const project = await hydrateSlidesProjectCandidate(
      candidate,
      baseSessionId(candidate),
    );
    if (project) return project;
  }

  return null;
}

export async function fetchSlidesWorkspaceContract(
  sessionId: string,
  slug: string,
): Promise<SlidesWorkspaceContract | null> {
  const statuses = await getSessionWorkspaceContract(sessionId);
  const slides = statuses.filter((status) => status.kind === "slides");
  return (
    slides.find((status) => status.slug === slug) ??
    slides[0] ??
    null
  );
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
  if (/\.(md|markdown|txt|js|ts|tsx|jsx|json)$/i.test(file.filename))
    return "report";
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

function resolveSlidesSlug(files: SlidesFileEntry[]): string | null {
  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, "/");
    // Match either `…/slides/<slug>/…` (legacy) or
    // `…/skill-output/slides/<slug>/…` (mofa-slides output).
    const match = normalizedPath.match(/\/(?:skill-output\/)?slides\/([^/]+)\//);
    if (match?.[1]) {
      return match[1];
    }
    const normalizedGroup = normalizeSlidesDir(file.group);
    const groupMatch = normalizedGroup.match(/^(?:skill-output\/)?slides\/([^/]+)/);
    if (groupMatch?.[1]) {
      return groupMatch[1];
    }
  }
  return null;
}

async function buildSlidesProjectFromFiles(
  sessionId: string,
  files: SlidesFileEntry[],
): Promise<SlidesProject | null> {
  if (files.length === 0) return null;
  const slug = resolveSlidesSlug(files);
  if (!slug) return null;

  const manifest = await fetchSlidesManifest(slug, files);
  const slides: Slide[] =
    manifest?.slides.map((slide, index) => ({
      index,
      title: `Slide ${index + 1}`,
      notes: "",
      layout: index === 0 ? "title" : "content",
      thumbnailUrl: slide.path,
    })) ?? [];

  const pptxPath =
    manifest?.outFile ||
    files
      .filter((file) => /\.pptx$/i.test(file.filename))
      .sort((left, right) => right.modified.localeCompare(left.modified))[0]
      ?.path;

  return {
    id: sessionId,
    title: titleFromSlidesSlug(slug),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scaffolded: true,
    slug,
    slides,
    pptxPath,
    pptxUrl: pptxPath ? buildFileUrl(pptxPath) : undefined,
    template: "business",
    tags: [],
    versions: [],
    manifestGeneratedAt: manifest?.generatedAt,
  };
}

async function hydrateSlidesProjectCandidate(
  lookupSessionId: string,
  projectSessionId: string,
): Promise<SlidesProject | null> {
  // The mofa-slides plugin writes its generated images and PPTX under
  // `skill-output/slides/<slug>/output/` (the plugin-output convention),
  // not under `slides/<slug>/output/imgs/` where this client originally
  // looked. List BOTH so the manifest/synthesizer can pull the rendered
  // images for the center-panel preview. Without this second dir the
  // file array only carries the scaffold trio (script.js / memory.md /
  // changelog.md) and the deck shows zero slides even after a
  // successful render.
  const files = await listSlidesFiles(["slides", "skill-output/slides"], {
    sessionId: lookupSessionId,
  });
  const sessionFiles = await getSessionFiles(lookupSessionId).catch(() => []);
  const mergedFiles = [
    ...files,
    ...sessionFiles
      .filter((file) => /\.(pptx|key)$/i.test(file.filename))
      .map(
        (file): SlidesFileEntry => ({
          filename: file.filename,
          path: file.path,
          size: file.size_bytes,
          modified: file.modified_at,
          category: "slides",
          group: "session",
        }),
      ),
  ];
  return buildSlidesProjectFromFiles(projectSessionId, mergedFiles);
}

function baseSessionId(sessionId: string): string {
  return sessionId.split("#")[0] || sessionId;
}

function alternateSlidesSessionCandidates(
  requestedSessionId: string,
  allSessionIds: string[],
): string[] {
  const requestedBase = baseSessionId(requestedSessionId);
  const cohortPrefix = requestedBase.match(/^(slides-\d+-)/)?.[1] ?? null;
  const candidates: string[] = [];
  const seen = new Set<string>();

  const push = (sessionId: string) => {
    if (!sessionId || sessionId === requestedSessionId || seen.has(sessionId))
      return;
    seen.add(sessionId);
    candidates.push(sessionId);
  };

  for (const sessionId of allSessionIds) {
    if (sessionId.startsWith(`${requestedBase}#slides `)) {
      push(sessionId);
    }
  }

  if (!cohortPrefix) {
    return candidates;
  }

  for (const sessionId of allSessionIds) {
    if (
      sessionId.startsWith(cohortPrefix) &&
      (sessionId.includes("#slides ") ||
        /^slides-\d+-[a-z0-9]+$/i.test(sessionId))
    ) {
      push(sessionId);
    }
  }

  return candidates;
}

function titleFromSlidesSlug(slug: string): string {
  return (
    slug
      .replace(/-[a-z0-9]{6}$/i, "")
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "Untitled Deck"
  );
}

function resolveSlidesManifestPath(
  slug: string,
  files: SlidesFileEntry[],
): string | null {
  const normalizedSlug = normalizeSlidesDir(slug).split("/").pop() || slug;
  const projectGroup = `slides/${normalizedSlug}`;
  // mofa-slides writes its output under `skill-output/slides/<slug>/`;
  // legacy/manual runs wrote directly under `slides/<slug>/`. Accept
  // both so hydration finds the manifest regardless of layout.
  const skillOutputGroup = `skill-output/slides/${normalizedSlug}`;

  // Find ALL manifest.json files under either project output/ directory.
  // Pick the most recently modified one — handles cases like output/imgs/,
  // output/imgs_5pages/, etc.
  const manifests = files.filter((file) => {
    if (file.filename !== "manifest.json") return false;
    const normalizedGroup = normalizeSlidesDir(file.group);
    return (
      normalizedGroup === `${projectGroup}/output/imgs` ||
      normalizedGroup.startsWith(`${projectGroup}/output/`) ||
      normalizedGroup === `${skillOutputGroup}/output/imgs` ||
      normalizedGroup.startsWith(`${skillOutputGroup}/output/`)
    );
  });

  if (manifests.length === 0) {
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

  if (
    normalizedGroup === normalizedDir ||
    normalizedGroup.startsWith(`${normalizedDir}/`)
  ) {
    return true;
  }

  if (
    normalizedPath === normalizedDir ||
    normalizedPath.endsWith(`/${normalizedDir}`)
  ) {
    return true;
  }

  return normalizedPath.includes(`/${normalizedDir}/`);
}

function ensureCoreSlidesFiles(
  files: SlidesFileEntry[],
  requestedDirs: string[],
): SlidesFileEntry[] {
  const nextFiles = [...files];
  const seenPaths = new Set(
    nextFiles.map((file) => normalizeSlidesDir(file.path)),
  );

  for (const dir of requestedDirs) {
    const parts = dir.split("/");
    if (!(parts[0] === "slides" && parts.length === 2)) continue;

    const dirFiles = nextFiles.filter((file) =>
      fileMatchesSlidesDir(file, dir),
    );
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
  files: SlidesFileEntry[],
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
    generatedAt: typeof raw.generated_at === "string" ? raw.generated_at : "",
    slideDir:
      typeof raw.slide_dir === "string"
        ? resolveManifestPath(raw.slide_dir, manifestPath, files)
        : "",
    outFile:
      typeof raw.out_file === "string"
        ? resolveManifestPath(raw.out_file, manifestPath, files)
        : "",
    slideCount:
      typeof raw.slide_count === "number" && Number.isFinite(raw.slide_count)
        ? raw.slide_count
        : rawSlides.length,
    slides: rawSlides
      .map((slide, position) =>
        normalizeManifestSlide(slide, position, manifestPath, files),
      )
      .filter((slide): slide is SlidesManifestSlide => !!slide),
    manifestPath,
  };
}

function normalizeManifestSlide(
  value: unknown,
  position: number,
  manifestPath: string,
  files: SlidesFileEntry[],
): SlidesManifestSlide | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.path !== "string" || raw.path.length === 0) return null;
  const resolvedPath = resolveManifestPath(raw.path, manifestPath, files);

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

function resolveManifestPath(
  path: string,
  manifestPath: string,
  files: SlidesFileEntry[],
): string {
  const normalizedPath = path.replace(/\\/g, "/");
  if (
    normalizedPath.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedPath) ||
    /^https?:\/\//i.test(normalizedPath)
  ) {
    return normalizedPath;
  }

  const manifestDir = normalizeSlidesDir(manifestPath).replace(
    /\/manifest\.json$/i,
    "",
  );
  const normalizedRequested = normalizeSlidesDir(normalizedPath);
  const matchedFile = files.find((file) => {
    const normalizedGroup = normalizeSlidesDir(file.group);
    const groupedPath = normalizeSlidesDir(
      `${normalizedGroup}/${file.filename}`,
    );
    return groupedPath === normalizedRequested;
  });
  if (matchedFile) {
    return matchedFile.path;
  }

  const matchedDir = files.find(
    (file) => normalizeSlidesDir(file.group) === normalizedRequested,
  );
  if (matchedDir) {
    const fullPath = matchedDir.path.replace(/\\/g, "/");
    const suffix = `/${matchedDir.filename}`;
    return fullPath.endsWith(suffix)
      ? fullPath.slice(0, -suffix.length)
      : fullPath;
  }

  const normalizedManifest = manifestPath.replace(/\\/g, "/");
  const markerIndex = normalizedManifest.indexOf("/slides/");
  if (normalizedPath.startsWith("slides/") && markerIndex !== -1) {
    const workspaceRoot = normalizedManifest.slice(0, markerIndex + 1);
    return `${workspaceRoot}${normalizedPath}`;
  }
  return `${manifestDir}/${normalizedPath.replace(/^\.?\//, "")}`;
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
