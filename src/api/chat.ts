import { getToken } from "./client";
import { API_BASE } from "@/lib/constants";
import type { ChatResponse } from "./types";
import { request } from "./client";

export async function sendMessage(
  message: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  return request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      message,
      session_id: sessionId,
    }),
    signal,
  });
}

/** Upload files to the server. Returns array of server-side file paths. */
export async function uploadFiles(files: File[]): Promise<string[]> {
  const form = new FormData();
  for (const file of files) {
    form.append("file", file);
  }

  const token = getToken();
  const resp = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `Upload failed: HTTP ${resp.status}`);
  }

  return resp.json();
}
