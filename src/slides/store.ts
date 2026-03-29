import { useState, useCallback, useEffect } from "react";
import type { SlidesProject } from "./types";

const STORAGE_KEY = "octos-slides-projects";

function loadProjects(): SlidesProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveProjects(projects: SlidesProject[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function generateSlidesId(): string {
  return `slides-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── CRUD operations ───────────────────────────────────

export function getAllSlidesProjects(): SlidesProject[] {
  return loadProjects().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSlidesProject(id: string): SlidesProject | undefined {
  return loadProjects().find((p) => p.id === id);
}

export function createSlidesProject(
  partial: Partial<SlidesProject> & { title: string },
): SlidesProject {
  const now = Date.now();
  const project: SlidesProject = {
    id: generateSlidesId(),
    createdAt: now,
    updatedAt: now,
    chatSessionId: `slides-${now}-${Math.random().toString(36).slice(2, 8)}`,
    slides: [],
    template: "business",
    tags: [],
    versions: [],
    ...partial,
  };
  const projects = loadProjects();
  projects.unshift(project);
  saveProjects(projects);
  return project;
}

export function updateSlidesProject(
  id: string,
  update: Partial<SlidesProject>,
): SlidesProject | undefined {
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return undefined;
  projects[idx] = { ...projects[idx], ...update, updatedAt: Date.now() };
  saveProjects(projects);
  return projects[idx];
}

export function deleteSlidesProject(id: string): void {
  const projects = loadProjects().filter((p) => p.id !== id);
  saveProjects(projects);
}

/** Search projects by query (title, tags, slide titles/notes). */
export function searchSlidesProjects(
  query: string,
  projects?: SlidesProject[],
): SlidesProject[] {
  const all = projects ?? getAllSlidesProjects();
  if (!query.trim()) return all;
  const q = query.toLowerCase();
  return all.filter(
    (p) =>
      p.title.toLowerCase().includes(q) ||
      p.tags.some((t) => t.includes(q)) ||
      p.template.includes(q) ||
      p.slides.some(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.notes.toLowerCase().includes(q),
      ),
  );
}

// ── React hooks ───────────────────────────────────────

/** Hook to list all slides projects with reactive updates. */
export function useSlidesProjects() {
  const [projects, setProjects] = useState<SlidesProject[]>(
    getAllSlidesProjects,
  );

  const refresh = useCallback(() => {
    setProjects(getAllSlidesProjects());
  }, []);

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [refresh]);

  const create = useCallback(
    (title: string, partial?: Partial<SlidesProject>) => {
      const project = createSlidesProject({ title, ...partial });
      refresh();
      return project;
    },
    [refresh],
  );

  const remove = useCallback(
    (id: string) => {
      deleteSlidesProject(id);
      refresh();
    },
    [refresh],
  );

  return { projects, create, remove, refresh };
}

/** Hook to manage a single slides project. */
export function useSlidesProject(projectId: string | undefined) {
  const [project, setProject] = useState<SlidesProject | undefined>(() =>
    projectId ? getSlidesProject(projectId) : undefined,
  );

  useEffect(() => {
    if (projectId) setProject(getSlidesProject(projectId));
    else setProject(undefined);
  }, [projectId]);

  const save = useCallback(
    (update: Partial<SlidesProject>) => {
      if (!projectId) return;
      const updated = updateSlidesProject(projectId, update);
      if (updated) setProject(updated);
    },
    [projectId],
  );

  const reload = useCallback(() => {
    if (projectId) setProject(getSlidesProject(projectId));
  }, [projectId]);

  return { project, save, reload };
}
