/**
 * Runtime provider — manages session lifecycle and message history loading.
 *
 * No longer uses assistant-ui's runtime. Instead, the SSE bridge writes
 * directly to the message store, and the ChatThread reads from it.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { SessionProvider, useSession } from "./session-context";
import * as StreamManager from "./stream-manager";
import { resumeSessionStream } from "./sse-bridge";
import * as FileStore from "@/store/file-store";
import * as MessageStore from "@/store/message-store";
import { getSessionStatus } from "@/api/sessions";

/** Max sessions kept in memory simultaneously. */
const MAX_CACHED = 5;

/** Tracks which sessions have been mounted so we can evict old ones. */
function RuntimeWithSession({ children }: { children: ReactNode }) {
  const { currentSessionId, setServerTaskActive } = useSession();
  const mountedRef = useRef(new Set<string>());

  // Load message history into the store when a session is activated
  useEffect(() => {
    MessageStore.loadHistory(currentSessionId);
    void FileStore.loadSessionFiles(currentSessionId);
    mountedRef.current.add(currentSessionId);

    // Evict old sessions if over limit
    if (mountedRef.current.size > MAX_CACHED) {
      for (const id of mountedRef.current) {
        if (id !== currentSessionId && !StreamManager.isActive(id)) {
          mountedRef.current.delete(id);
          MessageStore.clearMessages(id);
          break;
        }
      }
    }
  }, [currentSessionId]);

  // Poll for response if the server has an active task (e.g. after browser refresh)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await MessageStore.loadHistory(currentSessionId);
        await FileStore.loadSessionFiles(currentSessionId);
        if (cancelled) return;

        const status = await getSessionStatus(currentSessionId);
        setServerTaskActive(currentSessionId, status.active);
        if (!status.active || cancelled) return;

        MessageStore.ensureStreamingAssistantMessage(
          currentSessionId,
          status.has_deferred_files
            ? "Background tasks are still running..."
            : "Resuming ongoing work...",
        );
        resumeSessionStream(currentSessionId);

        // Server is still processing — show thinking indicator
        window.dispatchEvent(
          new CustomEvent("crew:thinking", {
            detail: { thinking: true, iteration: 0, sessionId: currentSessionId },
          }),
        );

        // Poll until the task completes
        for (let i = 0; i < 360; i++) {
          if (cancelled) break;
          await new Promise((r) => setTimeout(r, 5000));
          try {
            await FileStore.loadSessionFiles(currentSessionId);
            const s = await getSessionStatus(currentSessionId);
            setServerTaskActive(currentSessionId, s.active);
            if (!s.active) break;
          } catch {
            // keep polling
          }
        }

        // Reload history now that the task is done
        if (!cancelled) {
          await FileStore.loadSessionFiles(currentSessionId);
          MessageStore.clearMessages(currentSessionId);
          await MessageStore.loadHistory(currentSessionId);
          window.dispatchEvent(
            new CustomEvent("crew:thinking", {
              detail: { thinking: false, iteration: 0, sessionId: currentSessionId },
            }),
          );
          setServerTaskActive(currentSessionId, false);
        }
      } catch {
        // status endpoint unavailable — not fatal
        setServerTaskActive(currentSessionId, false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentSessionId, setServerTaskActive]);

  return <>{children}</>;
}

export function OctosRuntimeProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <RuntimeWithSession>{children}</RuntimeWithSession>
    </SessionProvider>
  );
}
