import type { Source } from "./types";

// Stub: localStorage until backend is ready
const STORAGE_KEY = "mofa_sources";

function loadSources(): Source[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveSources(sources: Source[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
}

export async function listSources(notebookId: string): Promise<Source[]> {
  return loadSources().filter((s) => s.notebook_id === notebookId);
}

export async function addSource(
  notebookId: string,
  opts: { type: Source["type"]; filename: string; content?: string },
): Promise<Source> {
  const src: Source = {
    id: `src-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    notebook_id: notebookId,
    type: opts.type,
    filename: opts.filename,
    status: "ready", // stub: immediately ready
    chunk_count: 0,
    created_at: new Date().toISOString(),
  };
  const all = loadSources();
  all.push(src);
  saveSources(all);

  // Update notebook source_count
  const nbKey = "mofa_notebooks";
  try {
    const nbs = JSON.parse(localStorage.getItem(nbKey) || "[]");
    const idx = nbs.findIndex((n: { id: string }) => n.id === notebookId);
    if (idx !== -1) {
      nbs[idx].source_count = (nbs[idx].source_count || 0) + 1;
      localStorage.setItem(nbKey, JSON.stringify(nbs));
    }
  } catch { /* */ }

  return src;
}

export async function deleteSource(notebookId: string, sourceId: string): Promise<void> {
  const all = loadSources().filter((s) => !(s.id === sourceId && s.notebook_id === notebookId));
  saveSources(all);

  // Update notebook source_count
  const nbKey = "mofa_notebooks";
  try {
    const nbs = JSON.parse(localStorage.getItem(nbKey) || "[]");
    const idx = nbs.findIndex((n: { id: string }) => n.id === notebookId);
    if (idx !== -1) {
      nbs[idx].source_count = Math.max(0, (nbs[idx].source_count || 1) - 1);
      localStorage.setItem(nbKey, JSON.stringify(nbs));
    }
  } catch { /* */ }
}
