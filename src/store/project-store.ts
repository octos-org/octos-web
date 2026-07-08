import { useCallback, useSyncExternalStore } from "react";

import { getAllSlidesProjects } from "@/slides/store";
import { getAllSiteProjects } from "@/sites/store";

// Unified project aggregation for the Octos Home launcher. Merges the three
// independent localStorage-backed sources (slide decks, site scaffolds, and
// chat/studio sessions) into one `ProjectSummary` feed, decorated with
// launcher-only favorite/archive flags kept under their own storage key so
// the source stores stay untouched.

const SLIDES_STORAGE_KEY = "octos-slides-projects";
const SITES_STORAGE_KEY = "octos-sites-projects";
const SESSION_TITLES_STORAGE_KEY = "octos_session_titles";
const FLAGS_STORAGE_KEY = "octos-project-flags";

const WATCHED_STORAGE_KEYS: readonly string[] = [
  SLIDES_STORAGE_KEY,
  SITES_STORAGE_KEY,
  SESSION_TITLES_STORAGE_KEY,
  FLAGS_STORAGE_KEY,
];

export type ProjectKind = "studio" | "slides" | "site";

export interface ProjectSummary {
  id: string;
  kind: ProjectKind;
  title: string;
  updatedAt: number; // epoch ms
  meta: string; // e.g. "5 slides · business" | "docs · signal-atlas" | "Studio session"
  href: string; // "/studio/<id>" | "/slides/<id>" | "/sites/<id>"
  favorite: boolean;
  archived: boolean;
}

interface ProjectFlags {
  favorite?: boolean;
  archived?: boolean;
  /** Last time the user opened the project from this browser (epoch ms). */
  openedAt?: number;
}

function loadFlags(): Record<string, ProjectFlags> {
  try {
    const raw = localStorage.getItem(FLAGS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, ProjectFlags>)
      : {};
  } catch {
    return {};
  }
}

function saveFlags(flags: Record<string, ProjectFlags>): void {
  try {
    localStorage.setItem(FLAGS_STORAGE_KEY, JSON.stringify(flags));
  } catch {
    // Quota/serialization failures lose a decoration, never project data.
  }
}

function loadSessionTitles(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SESSION_TITLES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Session-id → creation epoch ms; 0 when unparsable. Mirrors the two live
 * id formats `sessionTimestamp()` handles in session-context.tsx: the
 * client's `web-<epochms>-<rand6>` and the backend-minted `web-<uuid-v7>`
 * (first 12 hex chars = 48-bit ms timestamp).
 */
function parseSessionCreatedAt(id: string): number {
  const rest = id.replace(/^web-/, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(rest)) {
    const ts = parseInt(rest.replace(/-/g, "").slice(0, 12), 16);
    return Number.isFinite(ts) ? ts : 0;
  }
  const match = /^(\d+)-/.exec(rest);
  if (!match) return 0;
  const ts = Number(match[1]);
  return Number.isFinite(ts) ? ts : 0;
}

/** Source stores tolerate JSON.parse failures but not wrong-shape JSON
 *  (e.g. an object where an array is expected → `.sort` throws). Guard
 *  here so one corrupted key never blanks the whole launcher. */
function safeSlidesProjects() {
  try {
    const all = getAllSlidesProjects();
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

function safeSiteProjects() {
  try {
    const all = getAllSiteProjects();
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

/** All three sources merged, sorted updatedAt desc. */
export function listProjects(): ProjectSummary[] {
  const flags = loadFlags();
  const decorate = (
    summary: Omit<ProjectSummary, "favorite" | "archived">,
  ): ProjectSummary => {
    const entry = flags[summary.id];
    const openedAt = typeof entry?.openedAt === "number" ? entry.openedAt : 0;
    return {
      ...summary,
      updatedAt: Math.max(summary.updatedAt, openedAt),
      favorite: entry?.favorite === true,
      archived: entry?.archived === true,
    };
  };

  const slides = safeSlidesProjects().map((project) =>
    decorate({
      id: project.id,
      kind: "slides",
      title: project.title,
      updatedAt: Number(project.updatedAt) || 0,
      meta: `${Array.isArray(project.slides) ? project.slides.length : 0} slides · ${project.template}`,
      href: `/slides/${project.id}`,
    }),
  );

  const sites = safeSiteProjects().map((project) =>
    decorate({
      id: project.id,
      kind: "site",
      title: project.title,
      updatedAt: Number(project.updatedAt) || 0,
      meta: `${project.siteKind} · ${project.slug}`,
      href: `/sites/${project.id}`,
    }),
  );

  // Only "web-*" ids are real chat sessions; the titles cache also holds
  // slides/site scaffold entries which already surface via their own stores.
  const sessions = Object.entries(loadSessionTitles())
    .filter(([id]) => id.startsWith("web-"))
    .map(([id, title]) =>
      decorate({
        id,
        kind: "studio",
        title:
          typeof title === "string" && title.trim()
            ? title
            : "Untitled session",
        updatedAt: parseSessionCreatedAt(id),
        meta: "Studio session",
        href: `/studio/${id}`,
      }),
    );

  return [...slides, ...sites, ...sessions].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

// Snapshot store (repo convention — see file-store/content-store): a cached
// list invalidated on change, subscribed via useSyncExternalStore so the
// hook never sets state inside effects. `storage` events cover other tabs;
// same-tab mutations go through the exported mutators, which notify.
let snapshot: ProjectSummary[] | null = null;
const listeners = new Set<() => void>();

function notifyProjectsChanged(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // First subscriber of a fresh mount re-reads storage, so a remounted
  // launcher (or a new test case) never sees a stale cached snapshot.
  if (listeners.size === 0) snapshot = null;
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || WATCHED_STORAGE_KEYS.includes(event.key)) {
      notifyProjectsChanged();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): ProjectSummary[] {
  if (snapshot === null) snapshot = listProjects();
  return snapshot;
}

/**
 * Stamp a local "last opened" time so Recent Projects reflects actual
 * usage, not just creation/edit times (chat sessions especially have no
 * offline activity signal).
 */
export function recordProjectOpened(id: string): void {
  const flags = loadFlags();
  flags[id] = { ...(flags[id] ?? {}), openedAt: Date.now() };
  saveFlags(flags);
  notifyProjectsChanged();
}

export function toggleFavorite(id: string): void {
  const flags = loadFlags();
  const current = flags[id] ?? {};
  flags[id] = { ...current, favorite: current.favorite !== true };
  saveFlags(flags);
  notifyProjectsChanged();
}

export function setArchived(id: string, archived: boolean): void {
  const flags = loadFlags();
  flags[id] = { ...(flags[id] ?? {}), archived };
  saveFlags(flags);
  notifyProjectsChanged();
}

export function useProjects(): {
  projects: ProjectSummary[];
  refresh: () => void;
  toggleFavorite: (id: string) => void;
  setArchived: (id: string, archived: boolean) => void;
} {
  const projects = useSyncExternalStore(subscribe, getSnapshot);
  const refresh = useCallback(() => notifyProjectsChanged(), []);
  return { projects, refresh, toggleFavorite, setArchived };
}
