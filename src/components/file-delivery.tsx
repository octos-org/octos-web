import { useEffect, useState } from "react";
import { getToken } from "@/api/client";
import { buildFileUrl } from "@/api/files";

interface DeliveredFile {
  filePath: string;
  blobUrl?: string;
  filename: string;
  caption: string;
  sessionId: string;
  messageEpoch: number;
}

// Current message epoch — incremented on each new chat request
let currentEpoch = 0;
const deliveredFiles: DeliveredFile[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

/** Call this when a new user message is sent to clear stale file deliveries. */
export function clearFileDeliveries() {
  // Revoke blob URLs for files from previous epochs to free memory
  for (let i = deliveredFiles.length - 1; i >= 0; i--) {
    if (deliveredFiles[i].messageEpoch < currentEpoch) {
      if (deliveredFiles[i].blobUrl) URL.revokeObjectURL(deliveredFiles[i].blobUrl!);
      deliveredFiles.splice(i, 1);
    }
  }
  currentEpoch++;
}

async function addFile(file: DeliveredFile) {
  if (deliveredFiles.some((f) => f.filePath === file.filePath)) return;
  file.messageEpoch = currentEpoch;
  deliveredFiles.push(file);
  notify();

  try {
    const token = getToken();
    const fetchUrl = buildFileUrl(file.filePath);
    const resp = await fetch(fetchUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (resp.ok) {
      const blob = await resp.blob();
      file.blobUrl = URL.createObjectURL(blob);
      notify();
    }
  } catch {
    // Blob fetch failed
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("crew:file", (e: Event) => {
    const { fileUrl, filename, caption, sessionId } = (e as CustomEvent).detail;
    const pathMatch = fileUrl?.match(/\/api\/files\/(.+)/);
    const filePath = pathMatch ? decodeURIComponent(pathMatch[1]) : fileUrl;
    if (filePath && filename) {
      addFile({ filePath, filename, caption: caption || "", sessionId: sessionId || "", messageEpoch: currentEpoch });
    }
  });
}

/** Renders file download links from the current message's background tasks. */
export function FileDelivery({ sessionId }: { sessionId?: string }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const update = () => setTick((t) => t + 1);
    listeners.add(update);
    return () => { listeners.delete(update); };
  }, []);

  // Only show files from the current epoch (current message exchange)
  const files = deliveredFiles.filter(
    (f) => f.messageEpoch === currentEpoch && (!sessionId || f.sessionId === sessionId)
  );

  if (files.length === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      {files.map((f, i) => {
        const isAudio = /\.(mp3|wav|ogg|m4a|opus)$/i.test(f.filename);
        return (
          <div key={i} className="rounded-lg bg-surface-alt/50 p-3">
            {isAudio ? (
              <div>
                <div className="mb-1.5 text-xs text-muted">🎵 {f.filename}{f.caption}</div>
                {f.blobUrl ? (
                  <audio key={f.blobUrl} controls preload="metadata" className="w-full h-8">
                    <source src={f.blobUrl} />
                  </audio>
                ) : (
                  <div className="text-xs text-muted animate-pulse">Loading audio...</div>
                )}
              </div>
            ) : (
              <a
                href={f.blobUrl || buildFileUrl(f.filePath)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
              >
                📄 {f.filename}{f.caption}
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
