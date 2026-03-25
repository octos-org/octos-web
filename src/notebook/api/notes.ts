import { request } from "@/api/client";
import type { Note } from "./types";

export async function listNotes(notebookId: string): Promise<Note[]> {
  return request<Note[]>(`/api/notebooks/${notebookId}/notes`);
}

export async function createNote(
  notebookId: string,
  opts: { content: string; source_refs?: string[]; created_from?: Note["created_from"] },
): Promise<Note> {
  return request<Note>(`/api/notebooks/${notebookId}/notes`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export async function updateNote(notebookId: string, noteId: string, content: string): Promise<Note> {
  return request<Note>(`/api/notebooks/${notebookId}/notes/${noteId}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

export async function deleteNote(notebookId: string, noteId: string): Promise<void> {
  await request(`/api/notebooks/${notebookId}/notes/${noteId}`, { method: "DELETE" });
}
