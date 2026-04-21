import { useSyncExternalStore } from "react";
import { buildApiHeaders } from "@/api/client";
import { buildFileUrl } from "@/api/files";
import { getSessionFiles } from "@/api/sessions";
import { API_BASE } from "@/lib/constants";
import { displayFilenameFromPath } from "@/lib/utils";
import { eventSessionId } from "@/runtime/event-scope";

export interface FileEntry {
  id: string;
  sessionId: string;
  filename: string;
  filePath: string;
  size?: number;
  status: "generating" | "ready";
  blobUrl?: string;
  timestamp: number;
  toolName?: string;
  caption?: string;
}

type NewFileEntry = Omit<FileEntry, "id" | "timestamp" | "status"> & {
  size?: number;
  timestamp?: number;
};

// --- Internal state (profile-scoped, not session-scoped) ---
const allFiles: FileEntry[] = [];
const listeners = new Set<() => void>();

let version = 0;

// Snapshot caches — replaced on every notify() so useSyncExternalStore
// can detect changes by reference equality.
let allFilesSnapshot: FileEntry[] = allFiles;
const sessionSnapshots = new Map<string, { version: number; data: FileEntry[] }>();

function notify() {
  version++;
  allFilesSnapshot = [...allFiles];
  sessionSnapshots.clear();
  listeners.forEach((fn) => fn());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// --- Public API ---

export function addFile(entry: NewFileEntry) {
  const sessionId = entry.sessionId || "";

  // Keep files distinct per session. The same physical path can legitimately
  // appear in multiple sessions, especially for shared research outputs.
  // Still merge legacy unscoped entries into a scoped session when possible.
  const existing =
    allFiles.find(
      (file) => file.filePath === entry.filePath && file.sessionId === sessionId,
    ) ||
    (sessionId
      ? allFiles.find(
          (file) => file.filePath === entry.filePath && file.sessionId === "",
        )
      : allFiles.find((file) => file.filePath === entry.filePath));
  if (existing) {
    let changed = false;
    if (!existing.sessionId && sessionId) {
      existing.sessionId = sessionId;
      changed = true;
    }
    if ((!existing.caption || existing.caption === "") && entry.caption) {
      existing.caption = entry.caption;
      changed = true;
    }
    if ((!existing.size || existing.size <= 0) && entry.size && entry.size > 0) {
      existing.size = entry.size;
      changed = true;
    }
    if (
      entry.timestamp &&
      (!existing.timestamp || entry.timestamp > existing.timestamp)
    ) {
      existing.timestamp = entry.timestamp;
      changed = true;
    }
    if (changed) notify();
    return;
  }

  const file: FileEntry = {
    ...entry,
    sessionId,
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: entry.timestamp ?? Date.now(),
    status: "generating",
  };
  allFiles.push(file);
  notify();

  // Fetch blob in background
  fetchBlob(file);
}

export function updateFile(id: string, updates: Partial<FileEntry>) {
  const idx = allFiles.findIndex((f) => f.id === id);
  if (idx !== -1) {
    allFiles[idx] = { ...allFiles[idx], ...updates };
    notify();
  }
}

export function removeFile(id: string): void {
  const idx = allFiles.findIndex((f) => f.id === id);
  if (idx !== -1) {
    const file = allFiles[idx];
    if (file.blobUrl) URL.revokeObjectURL(file.blobUrl);
    allFiles.splice(idx, 1);
    notify();
  }
}

export function revokeAll(): void {
  for (const file of allFiles) {
    if (file.blobUrl) URL.revokeObjectURL(file.blobUrl);
  }
  allFiles.length = 0;
  notify();
}

export function getAllFiles(): FileEntry[] {
  return allFiles;
}

/** @deprecated Use useAllFiles() instead */
export function getFilesForSession(sessionId: string): FileEntry[] {
  return allFiles.filter((f) => f.sessionId === sessionId);
}

async function fetchBlob(file: FileEntry) {
  try {
    const url = buildFileUrl(file.filePath);
    const resp = await fetch(url, {
      headers: buildApiHeaders(),
    });
    if (resp.ok) {
      const blob = await resp.blob();
      updateFile(file.id, {
        blobUrl: URL.createObjectURL(blob),
        size: blob.size,
        status: "ready",
      });
    } else {
      updateFile(file.id, { status: "ready" });
    }
  } catch {
    updateFile(file.id, { status: "ready" });
  }
}

export async function loadSessionFiles(sessionId: string): Promise<void> {
  try {
    const files = await getSessionFiles(sessionId);
    for (const file of files) {
      addFile({
        sessionId,
        filename: file.filename,
        filePath: file.path,
        size: file.size_bytes,
        timestamp: Date.parse(file.modified_at) || Date.now(),
        caption: "",
      });
    }
  } catch {
    // session file listing unavailable
  }
}

// --- DOM event listener ---
if (typeof window !== "undefined") {
  window.addEventListener("crew:file", (e: Event) => {
    const detail = (e as CustomEvent).detail as {
      fileUrl?: string;
      filename?: string;
      caption?: string;
      sessionId?: string;
    };
    const sessionId = eventSessionId(detail);
    if (!sessionId) return;
    const pathMatch = detail.fileUrl?.match(/\/api\/files\/(.+)/);
    const filePath = pathMatch ? decodeURIComponent(pathMatch[1]) : detail.fileUrl ?? "";
    if (filePath && detail.filename) {
      addFile({
        sessionId,
        filename: detail.filename,
        filePath,
        caption: detail.caption ?? "",
      });
      window.dispatchEvent(
        new CustomEvent("crew:file_notification", {
          detail: { filename: detail.filename, sessionId },
        }),
      );
    }
  });
}

// --- Load files from all session histories on startup ---

let filesLoaded = false;

export async function loadAllSessionFiles(): Promise<void> {
  if (filesLoaded) return;
  filesLoaded = true;

  // Load content files from profile directories (research, slides, skill-output)
  try {
    const resp = await fetch(
      `${API_BASE}/api/files/list?dirs=research,slides,skill-output`,
      { headers: buildApiHeaders() },
    );
    if (resp.ok) {
      const files = (await resp.json()) as {
        filename: string;
        path: string;
        size: number;
        modified: string;
        category: string;
        group: string;
      }[];
      for (const f of files) {
        addFile({
          sessionId: "_content",
          filename: f.filename,
          filePath: f.path,
          caption: f.group || f.category,
        });
      }
    }
  } catch {
    // content listing not available
  }

  // Also load from session message history
  try {
    const { listSessions, getMessages } = await import("@/api/sessions");
    const sessions = await listSessions();
    const webSessions = sessions
      .filter((s) => s.id.startsWith("web-") && (s.message_count ?? 0) > 0)
      .slice(0, 20); // limit to recent 20 sessions

    await Promise.allSettled(webSessions.map(async (session) => {
      const messages = await getMessages(session.id, 500, 0);
      for (const msg of messages) {
        // Check media array (new persist format)
        if (msg.media && msg.media.length > 0) {
          for (const path of msg.media) {
            const filename = displayFilenameFromPath(path);
            addFile({
              sessionId: session.id,
              filename,
              filePath: path,
              caption: "",
            });
          }
        }
        // Also parse [file:path] patterns from content (legacy format)
        const fileMatches = msg.content?.matchAll(/\[file:([^\]]+)\]/g);
        if (fileMatches) {
          for (const match of fileMatches) {
            const path = match[1];
            const filename = displayFilenameFromPath(path);
            addFile({
              sessionId: session.id,
              filename,
              filePath: path,
              caption: "",
            });
          }
        }
      }
    }));
  } catch {
    // sessions list failed, skip
  }
}

// --- React hooks ---

function getAllFilesSnapshot(): FileEntry[] {
  return allFilesSnapshot;
}

function getSessionSnapshot(sessionId: string): FileEntry[] {
  const cached = sessionSnapshots.get(sessionId);
  if (cached && cached.version === version) return cached.data;
  const data = allFiles.filter((f) => f.sessionId === sessionId);
  sessionSnapshots.set(sessionId, { version, data });
  return data;
}

/** Get ALL files across all sessions (profile-scoped). */
export function useAllFiles(): FileEntry[] {
  return useSyncExternalStore(subscribe, getAllFilesSnapshot, getAllFilesSnapshot);
}

/** @deprecated Use useAllFiles() instead */
export function useFileStore(sessionId: string): FileEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => getSessionSnapshot(sessionId),
    () => getSessionSnapshot(sessionId),
  );
}
