import { useSyncExternalStore } from "react";
import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";

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

// --- Internal state (profile-scoped, not session-scoped) ---
const allFiles: FileEntry[] = [];
const seenPaths = new Set<string>();
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

export function addFile(entry: Omit<FileEntry, "id" | "timestamp" | "status">) {
  // Deduplicate by filePath
  if (seenPaths.has(entry.filePath)) return;
  seenPaths.add(entry.filePath);

  const file: FileEntry = {
    ...entry,
    id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Date.now(),
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
    seenPaths.delete(file.filePath);
    allFiles.splice(idx, 1);
    notify();
  }
}

export function revokeAll(): void {
  for (const file of allFiles) {
    if (file.blobUrl) URL.revokeObjectURL(file.blobUrl);
  }
  allFiles.length = 0;
  seenPaths.clear();
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
    const token = getToken();
    const url = `${API_BASE}/api/files?path=${encodeURIComponent(file.filePath)}`;
    const resp = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
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

// --- DOM event listener ---
if (typeof window !== "undefined") {
  window.addEventListener("crew:file", (e: Event) => {
    const detail = (e as CustomEvent).detail as {
      fileUrl?: string;
      filename?: string;
      caption?: string;
      sessionId?: string;
    };
    const pathMatch = detail.fileUrl?.match(/\/api\/files\/(.+)/);
    const filePath = pathMatch ? decodeURIComponent(pathMatch[1]) : detail.fileUrl ?? "";
    if (filePath && detail.filename) {
      addFile({
        sessionId: detail.sessionId ?? "",
        filename: detail.filename,
        filePath,
        caption: detail.caption ?? "",
      });
      window.dispatchEvent(
        new CustomEvent("crew:file_notification", {
          detail: { filename: detail.filename, sessionId: detail.sessionId },
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
    const token = getToken();
    const resp = await fetch(
      `${API_BASE}/api/files/list?dirs=research,slides,skill-output`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
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
            const filename = path.split("/").pop() || "file";
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
            const filename = path.split("/").pop() || "file";
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
