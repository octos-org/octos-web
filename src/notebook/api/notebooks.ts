import { request } from "@/api/client";
import type { Notebook } from "./types";

export async function listNotebooks(): Promise<Notebook[]> {
  return request<Notebook[]>("/api/notebooks");
}

export async function createNotebook(title: string, description = ""): Promise<Notebook> {
  return request<Notebook>("/api/notebooks", {
    method: "POST",
    body: JSON.stringify({ title, description }),
  });
}

export async function getNotebook(id: string): Promise<Notebook> {
  return request<Notebook>(`/api/notebooks/${id}`);
}

export async function updateNotebook(id: string, updates: Partial<Pick<Notebook, "title" | "description">>): Promise<Notebook> {
  return request<Notebook>(`/api/notebooks/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
}

export async function deleteNotebook(id: string): Promise<void> {
  await request(`/api/notebooks/${id}`, { method: "DELETE" });
}
