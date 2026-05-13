import { buildApiHeaders } from "./client";
import { API_BASE } from "@/lib/constants";

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
    // ───── M12 Phase D-4 follow-up: no upload-side 401/403 reaper ─────
    //
    // Pre-D-4 this branch mirrored `request()` and called
    // `clearToken()` + hard-redirected to `/login` on a 401/403.
    // That contradicted D-4's promise that blob/file ops propagate
    // normal errors so the upload UI can render a contextual retry
    // instead of nuking the user's tokens mid-flow. The reaper now
    // lives ONLY in `src/api/client.ts` and ONLY for `/api/auth/*`.
    const text = await resp.text();
    throw new Error(text || `Upload failed: HTTP ${resp.status}`);
  }

  return resp.json();
}
