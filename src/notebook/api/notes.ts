import type { Note } from "./types";

const STORAGE_KEY = "mofa_notes";

function loadNotes(): Note[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveNotes(notes: Note[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

export async function listNotes(notebookId: string): Promise<Note[]> {
  return loadNotes().filter((n) => n.notebook_id === notebookId);
}

export async function createNote(
  notebookId: string,
  opts: { content: string; source_refs?: string[]; created_from?: Note["created_from"] },
): Promise<Note> {
  const note: Note = {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    notebook_id: notebookId,
    content: opts.content,
    source_refs: opts.source_refs || [],
    created_from: opts.created_from || "manual",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const all = loadNotes();
  all.unshift(note);
  saveNotes(all);
  return note;
}

export async function updateNote(noteId: string, content: string): Promise<Note> {
  const all = loadNotes();
  const idx = all.findIndex((n) => n.id === noteId);
  if (idx === -1) throw new Error("Note not found");
  all[idx] = { ...all[idx], content, updated_at: new Date().toISOString() };
  saveNotes(all);
  return all[idx];
}

export async function deleteNote(noteId: string): Promise<void> {
  const all = loadNotes().filter((n) => n.id !== noteId);
  saveNotes(all);
}
