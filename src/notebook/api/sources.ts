import { request } from "@/api/client";
import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";
import type { Source } from "./types";

export async function listSources(notebookId: string): Promise<Source[]> {
  return request<Source[]>(`/api/notebooks/${notebookId}/sources`);
}

export async function addSourceText(
  notebookId: string,
  opts: { text: string; filename?: string },
): Promise<Source> {
  return request<Source>(`/api/notebooks/${notebookId}/sources`, {
    method: "POST",
    body: JSON.stringify({ text: opts.text, filename: opts.filename }),
  });
}

export async function addSourceUrl(
  notebookId: string,
  url: string,
): Promise<Source> {
  return request<Source>(`/api/notebooks/${notebookId}/sources`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

export async function uploadSourceFile(
  notebookId: string,
  file: File,
): Promise<Source> {
  const token = getToken();
  const formData = new FormData();
  formData.append("file", file);

  const resp = await fetch(`${API_BASE}/api/notebooks/${notebookId}/sources/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `HTTP ${resp.status}`);
  }

  return resp.json();
}

export async function deleteSource(notebookId: string, sourceId: string): Promise<void> {
  await request(`/api/notebooks/${notebookId}/sources/${sourceId}`, { method: "DELETE" });
}
