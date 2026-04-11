import { useState, useCallback, useEffect } from "react";

import { getSelectedProfileId } from "@/api/client";

import type { SitePreset, SiteProject } from "./types";
import { SITE_PRESETS } from "./types";

const STORAGE_KEY = "octos-sites-projects";

function loadProjects(): SiteProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SiteProject[]) : [];
  } catch {
    return [];
  }
}

function saveProjects(projects: SiteProject[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function generateSiteId(): string {
  return `site-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getAllSiteProjects(): SiteProject[] {
  return loadProjects().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSiteProject(id: string): SiteProject | undefined {
  return loadProjects().find((project) => project.id === id);
}

export function createSiteProject(preset: SitePreset): SiteProject {
  const now = Date.now();
  const definition = SITE_PRESETS[preset];
  const sessionId = `site-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const project: SiteProject = {
    id: sessionId,
    title: definition.title,
    createdAt: now,
    updatedAt: now,
    profileId: getSelectedProfileId() || undefined,
    preset,
    template: definition.template,
    siteKind: definition.siteKind,
    slug: definition.slug,
  };

  const projects = loadProjects();
  projects.unshift(project);
  saveProjects(projects);
  return project;
}

export function updateSiteProject(
  id: string,
  update: Partial<SiteProject>,
): SiteProject | undefined {
  const projects = loadProjects();
  const index = projects.findIndex((project) => project.id === id);
  if (index === -1) return undefined;
  projects[index] = {
    ...projects[index],
    ...update,
    updatedAt: Date.now(),
  };
  saveProjects(projects);
  return projects[index];
}

export function upsertSiteProject(project: SiteProject): SiteProject {
  const projects = loadProjects();
  const index = projects.findIndex((entry) => entry.id === project.id);
  const nextProject: SiteProject =
    index === -1
      ? project
      : {
          ...projects[index],
          ...project,
          updatedAt: project.updatedAt || Date.now(),
        };

  if (index === -1) {
    projects.unshift(nextProject);
  } else {
    projects[index] = nextProject;
  }

  saveProjects(projects);
  return nextProject;
}

export function deleteSiteProject(id: string) {
  saveProjects(loadProjects().filter((project) => project.id !== id));
}

export function useSiteProjects() {
  const [projects, setProjects] = useState<SiteProject[]>(getAllSiteProjects);

  const refresh = useCallback(() => {
    setProjects(getAllSiteProjects());
  }, []);

  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) refresh();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [refresh]);

  const create = useCallback(
    (preset: SitePreset) => {
      const project = createSiteProject(preset);
      refresh();
      return project;
    },
    [refresh],
  );

  const remove = useCallback(
    (id: string) => {
      deleteSiteProject(id);
      refresh();
    },
    [refresh],
  );

  return { projects, create, remove, refresh };
}

export function useSiteProject(projectId: string | undefined) {
  const [project, setProject] = useState<SiteProject | undefined>(() =>
    projectId ? getSiteProject(projectId) : undefined,
  );

  useEffect(() => {
    setProject(projectId ? getSiteProject(projectId) : undefined);
  }, [projectId]);

  const save = useCallback(
    (update: Partial<SiteProject>) => {
      if (!projectId) return;
      const next = updateSiteProject(projectId, update);
      if (next) setProject(next);
    },
    [projectId],
  );

  const reload = useCallback(() => {
    if (!projectId) return;
    setProject(getSiteProject(projectId));
  }, [projectId]);

  return { project, save, reload };
}
