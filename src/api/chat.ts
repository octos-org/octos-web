import { buildApiHeaders, clearToken } from "./client";
import { API_BASE } from "@/lib/constants";
import type { ChatResponse } from "./types";
import { request } from "./client";

export async function sendMessage(
  message: string,
  sessionId?: string,
  topic?: string,
  clientMessageId?: string,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  return request("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      message,
      session_id: sessionId,
      topic,
      client_message_id: clientMessageId,
    }),
    signal,
  });
}

/** Upload files to the server. Returns array of server-side file paths. */
export async function uploadFiles(
  files: File[],
  audioUploadMode?: "recording" | "upload",
): Promise<string[]> {
  const form = new FormData();
  if (audioUploadMode) {
    form.append("audio_upload_mode", audioUploadMode);
  }
  for (const file of files) {
    form.append("file", file);
  }

  const resp = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    headers: buildApiHeaders(),
    body: form,
  });

  if (!resp.ok) {
    // Mirror the auto-logout behavior from request() on auth failure
    if (resp.status === 401 || resp.status === 403) {
      clearToken();
      if (!window.location.pathname.endsWith("/login")) {
        window.location.href =
          "/login?redirect=" + encodeURIComponent(window.location.pathname);
      }
    }
    const text = await resp.text();
    throw new Error(text || `Upload failed: HTTP ${resp.status}`);
  }

  return resp.json();
}
