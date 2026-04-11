import {
  buildApiHeaders,
  ensureSelectedProfileId,
  getSelectedProfileId,
} from "@/api/client";
import type { ContentEntry } from "@/api/content";
import { buildFileUrl } from "@/api/files";
import { API_BASE } from "@/lib/constants";
import type { SitePreset, SiteProject } from "./types";

export interface SiteFileEntry {
  filename: string;
  path: string;
  size: number;
  modified: string;
  category: string;
  group: string;
}

export interface SiteSessionMetadata {
  version: number;
  command: string;
  preset_key: string;
  template: string;
  site_kind: string;
  site_name: string;
  description: string;
  accent: string;
  reference: string;
  reference_label: string;
  site_slug: string;
  preview_base_path: string;
  preview_url: string;
  build_output_dir: string;
  project_dir: string;
  pages: Array<{
    title: string;
    slug: string;
    goal: string;
    sections: string[];
  }>;
}

interface ListSiteFilesOptions {
  sessionId?: string;
  profileId?: string;
  includeBuild?: boolean;
}

interface UploadSiteFilesOptions {
  profileId?: string;
  targetDir?: string;
}

function presetFromTemplate(template: string): SitePreset {
  switch (template) {
    case "astro-site":
      return "astro";
    case "nextjs-app":
      return "nextjs";
    case "react-vite":
      return "react";
    default:
      return "learning";
  }
}

export function buildSitePreviewUrl(
  sessionId: string,
  slug: string,
  profileIdOverride?: string | null,
): string {
  const profileId = profileIdOverride || getSelectedProfileId();
  if (profileId) {
    return `${API_BASE}/api/preview/${encodeURIComponent(profileId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(slug)}/index.html`;
  }
  return `${API_BASE}/api/site-preview/${encodeURIComponent(sessionId)}/${encodeURIComponent(slug)}/index.html`;
}

export async function listSiteFiles(
  dirs: string | string[],
  options: ListSiteFilesOptions = {},
): Promise<SiteFileEntry[]> {
  const profileId = options.profileId || (await ensureSelectedProfileId());
  const requestedDirs = (Array.isArray(dirs) ? dirs : [dirs]).map(normalizeDir);
  const params = new URLSearchParams({
    dirs: requestedDirs.join(","),
  });
  if (options.sessionId) {
    params.set("session_id", options.sessionId);
  }
  if (options.includeBuild) {
    params.set("include_build", "1");
  }

  const response = await fetch(`${API_BASE}/api/files/list?${params.toString()}`, {
    headers: buildApiHeaders({}, profileId),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const files = (await response.json()) as SiteFileEntry[];
  return files.filter((file) =>
    requestedDirs.some((dir) => fileMatchesDir(file, dir)),
  );
}

export async function uploadSiteFiles(
  sessionId: string,
  slug: string,
  files: File[],
  options: UploadSiteFilesOptions = {},
): Promise<SiteFileEntry[]> {
  if (files.length === 0) return [];

  const profileId = options.profileId || (await ensureSelectedProfileId());
  const formData = new FormData();
  formData.set("session_id", sessionId);
  formData.set("site_slug", slug);
  if (options.targetDir?.trim()) {
    formData.set("target_dir", options.targetDir.trim());
  }
  for (const file of files) {
    formData.append("file", file, file.name);
  }

  const response = await fetch(`${API_BASE}/api/site-files/upload`, {
    method: "POST",
    headers: buildApiHeaders({}, profileId),
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as SiteFileEntry[];
}

export async function fetchSiteSession(
  slug: string,
  files: SiteFileEntry[],
  options: { sessionId: string; profileId?: string } ,
): Promise<SiteSessionMetadata | null> {
  const profileId = options.profileId || (await ensureSelectedProfileId());
  const sessionPath = resolveSiteSessionPath(slug, files);
  if (!sessionPath) return null;

  const response = await fetch(buildFileUrl(sessionPath), {
    headers: buildApiHeaders({}, profileId),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as SiteSessionMetadata;
}

export async function hydrateSiteProjectFromSession(
  sessionId: string,
  profileIdOverride?: string | null,
): Promise<SiteProject | null> {
  const profileId = profileIdOverride || (await ensureSelectedProfileId());
  const files = await listSiteFiles("sites", {
    sessionId,
    profileId: profileId || undefined,
  });

  const slug = resolveSiteSlug(files);
  if (!slug) return null;

  const session = await fetchSiteSession(slug, files, {
    sessionId,
    profileId: profileId || undefined,
  });

  const template = session?.template || "astro-site";
  const siteKind = session?.site_kind || "docs";
  const siteSlug = session?.site_slug || slug;

  return {
    id: sessionId,
    title: session?.site_name || siteSlug,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    profileId: profileId || undefined,
    preset: presetFromTemplate(template),
    template,
    siteKind,
    slug: siteSlug,
    scaffolded: true,
    previewUrl:
      session?.preview_url ||
      buildSitePreviewUrl(sessionId, siteSlug, profileId || undefined),
  };
}

export function siteFileToContentEntry(
  file: SiteFileEntry,
  sessionId?: string,
): ContentEntry {
  return {
    id: file.path,
    filename: file.filename,
    path: file.path,
    category: inferContentCategory(file),
    size_bytes: file.size,
    created_at: file.modified,
    thumbnail_path: null,
    session_id: sessionId || null,
    tool_name: null,
    caption: file.group || null,
  };
}

export function inferContentCategory(
  file: Pick<SiteFileEntry, "filename" | "category">,
): ContentEntry["category"] {
  if (file.category === "image") return "image";
  if (file.category === "video") return "video";
  if (file.category === "audio") return "audio";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(file.filename)) return "image";
  if (/\.(mp4|webm|mov)$/i.test(file.filename)) return "video";
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(file.filename)) return "audio";
  return "report";
}

export function inferGroupName(
  file: Pick<SiteFileEntry, "path" | "group">,
  slug: string,
): string {
  if (file.group) return file.group;
  const marker = `/sites/${slug}/`;
  const normalized = file.path.replace(/\\/g, "/");
  const index = normalized.indexOf(marker);
  if (index === -1) return "files";
  const relative = normalized.slice(index + marker.length);
  const parts = relative.split("/").slice(0, -1);
  return parts.join("/") || "root";
}

function resolveSiteSessionPath(slug: string, files: SiteFileEntry[]): string | null {
  const normalizedSlug = normalizeDir(slug).split("/").pop() || slug;
  const marker = `/sites/${normalizedSlug}/`;
  for (const file of files) {
    if (file.filename !== "mofa-site-session.json") continue;
    const normalizedPath = file.path.replace(/\\/g, "/");
    if (normalizedPath.includes(marker)) {
      return file.path;
    }
  }
  return null;
}

function resolveSiteSlug(files: SiteFileEntry[]): string | null {
  for (const file of files) {
    if (
      file.filename !== "mofa-site-session.json" &&
      file.filename !== "site-plan.json"
    ) {
      continue;
    }

    const normalizedPath = file.path.replace(/\\/g, "/");
    const match = normalizedPath.match(/\/sites\/([^/]+)\//);
    if (match?.[1]) return match[1];
  }

  return null;
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function fileMatchesDir(
  file: Pick<SiteFileEntry, "path" | "group">,
  dir: string,
): boolean {
  const normalizedDir = normalizeDir(dir);
  const normalizedPath = normalizeDir(file.path);
  const normalizedGroup = normalizeDir(file.group);
  if (normalizedGroup === normalizedDir || normalizedGroup.startsWith(`${normalizedDir}/`)) {
    return true;
  }
  if (normalizedPath === normalizedDir || normalizedPath.endsWith(`/${normalizedDir}`)) {
    return true;
  }
  return normalizedPath.includes(`/${normalizedDir}/`);
}
