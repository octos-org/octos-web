import { useState, useCallback, useEffect } from "react";
import type { StudioProject } from "./types";

const STORAGE_KEY = "octos-studio-projects";

function loadProjects(): StudioProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveProjects(projects: StudioProject[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      // Evict oldest projects and retry
      if (projects.length > 1) {
        const sorted = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
        const trimmed = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 2)));
        console.warn(`[studio] localStorage quota exceeded, evicting ${projects.length - trimmed.length} old projects`);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
        } catch {
          console.error("[studio] localStorage quota exceeded even after eviction");
        }
      } else {
        console.error("[studio] localStorage quota exceeded, unable to save");
      }
    }
  }
}

export function generateProjectId(): string {
  return `studio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateSourceId(): string {
  return `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateOutputId(): string {
  return `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── CRUD operations ───────────────────────────────────

export function getAllProjects(): StudioProject[] {
  return loadProjects().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProject(id: string): StudioProject | undefined {
  return loadProjects().find((p) => p.id === id);
}

export function createProject(partial: Partial<StudioProject> & { title: string }): StudioProject {
  const now = Date.now();
  const project: StudioProject = {
    id: generateProjectId(),
    createdAt: now,
    updatedAt: now,
    chatSessionId: `web-${now}-${Math.random().toString(36).slice(2, 8)}`,
    sources: [],
    outputs: [],
    ...partial,
  };
  const projects = loadProjects();
  projects.unshift(project);
  saveProjects(projects);
  return project;
}

export function updateProject(id: string, update: Partial<StudioProject>): StudioProject | undefined {
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return undefined;
  projects[idx] = { ...projects[idx], ...update, updatedAt: Date.now() };
  saveProjects(projects);
  return projects[idx];
}

export function deleteProject(id: string): void {
  const projects = loadProjects().filter((p) => p.id !== id);
  saveProjects(projects);
}

// ── React hooks ───────────────────────────────────────

/** Hook to list all projects with reactive updates. */
export function useStudioProjects() {
  const [projects, setProjects] = useState<StudioProject[]>(getAllProjects);

  const refresh = useCallback(() => {
    setProjects(getAllProjects());
  }, []);

  // Listen for storage events from other tabs
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [refresh]);

  const create = useCallback((title: string, partial?: Partial<StudioProject>) => {
    const project = createProject({ title, ...partial });
    refresh();
    return project;
  }, [refresh]);

  const remove = useCallback((id: string) => {
    deleteProject(id);
    refresh();
  }, [refresh]);

  return { projects, create, remove, refresh };
}

/** Hook to manage a single project. */
export function useStudioProject(projectId: string | undefined) {
  const [project, setProject] = useState<StudioProject | undefined>(() =>
    projectId ? getProject(projectId) : undefined,
  );

  useEffect(() => {
    if (projectId) setProject(getProject(projectId));
    else setProject(undefined);
  }, [projectId]);

  const save = useCallback(
    (update: Partial<StudioProject>) => {
      if (!projectId) return;
      const updated = updateProject(projectId, update);
      if (updated) setProject(updated);
    },
    [projectId],
  );

  const reload = useCallback(() => {
    if (projectId) setProject(getProject(projectId));
  }, [projectId]);

  return { project, save, reload };
}
