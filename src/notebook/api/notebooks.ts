import { request } from "@/api/client";
import type { Notebook } from "./types";

// NOTE: These APIs are stubs for now — the backend endpoints don't exist yet.
// They use localStorage as a temporary store until the backend is ready.

const STORAGE_KEY = "mofa_notebooks";

function loadNotebooks(): Notebook[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveNotebooks(notebooks: Notebook[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notebooks));
}

export async function listNotebooks(): Promise<Notebook[]> {
  // TODO: replace with `request<Notebook[]>("/api/notebooks")` when backend is ready
  return loadNotebooks();
}

export async function createNotebook(title: string, description = ""): Promise<Notebook> {
  // TODO: replace with `request<Notebook>("/api/notebooks", { method: "POST", body: ... })`
  const nb: Notebook = {
    id: `nb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title,
    description,
    source_count: 0,
    note_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const all = loadNotebooks();
  all.unshift(nb);
  saveNotebooks(all);
  return nb;
}

export async function deleteNotebook(id: string): Promise<void> {
  // TODO: replace with `request("/api/notebooks/${id}", { method: "DELETE" })`
  const all = loadNotebooks().filter((n) => n.id !== id);
  saveNotebooks(all);
}

export async function updateNotebook(id: string, updates: Partial<Pick<Notebook, "title" | "description">>): Promise<Notebook> {
  const all = loadNotebooks();
  const idx = all.findIndex((n) => n.id === id);
  if (idx === -1) throw new Error("Notebook not found");
  all[idx] = { ...all[idx], ...updates, updated_at: new Date().toISOString() };
  saveNotebooks(all);
  return all[idx];
}
