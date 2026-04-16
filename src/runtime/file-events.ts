import { API_BASE } from "@/lib/constants";

interface CrewFileEventInput {
  sessionId: string;
  topic?: string;
  path: string;
  filename: string;
  caption?: string;
}

const seenFileEventKeys = new Set<string>();
const MAX_TRACKED_FILE_EVENTS = 1024;

function fileEventKey(sessionId: string, topic: string | undefined, path: string): string {
  return `${sessionId}::${topic?.trim() || ""}::${path}`;
}

function trimSeenFileEvents(): void {
  if (seenFileEventKeys.size < MAX_TRACKED_FILE_EVENTS) return;
  const oldest = seenFileEventKeys.values().next().value;
  if (oldest) seenFileEventKeys.delete(oldest);
}

export function dispatchCrewFileEvent({
  sessionId,
  topic,
  path,
  filename,
  caption = "",
}: CrewFileEventInput): void {
  const key = fileEventKey(sessionId, topic, path);
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
        topic,
      },
    }),
  );
}
