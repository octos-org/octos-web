import { API_BASE } from "@/lib/constants";

interface CrewFileEventInput {
  sessionId: string;
  path: string;
  filename: string;
  caption?: string;
}

const seenFileEventKeys = new Set<string>();
const MAX_TRACKED_FILE_EVENTS = 1024;

function fileEventKey(sessionId: string, path: string): string {
  return `${sessionId}::${path}`;
}

function trimSeenFileEvents(): void {
  if (seenFileEventKeys.size < MAX_TRACKED_FILE_EVENTS) return;
  const oldest = seenFileEventKeys.values().next().value;
  if (oldest) seenFileEventKeys.delete(oldest);
}

export function dispatchCrewFileEvent({
  sessionId,
  path,
  filename,
  caption = "",
}: CrewFileEventInput): void {
  const key = fileEventKey(sessionId, path);
  if (seenFileEventKeys.has(key)) return;
  trimSeenFileEvents();
  seenFileEventKeys.add(key);

  window.dispatchEvent(
    new CustomEvent("crew:file", {
      detail: {
        fileUrl: `${API_BASE}/api/files/${encodeURIComponent(path)}`,
        filename,
        caption,
        sessionId,
      },
    }),
  );
}
