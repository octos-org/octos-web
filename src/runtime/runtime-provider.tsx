/**
 * Runtime provider — manages session lifecycle and authoritative background sync.
 *
 * The runtime layer owns session recovery and background-task polling. UI
 * components read from stores only; they do not drive `/tasks` or `/messages`
 * synchronization themselves.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { SessionProvider, useSession } from "./session-context";
import * as StreamManager from "./stream-manager";
import { resumeSessionStream } from "./sse-bridge";
import * as FileStore from "@/store/file-store";
import * as MessageStore from "@/store/message-store";
import * as TaskStore from "@/store/task-store";
import { getSessionStatus } from "@/api/sessions";
import type { BackgroundTaskInfo } from "@/api/types";
import { restoreWatchedSessions, unwatchSession, watchSession } from "./task-watcher";
/** Max sessions kept in memory simultaneously. */
const MAX_CACHED = 5;

/** Tracks which sessions have been mounted so we can evict old ones. */
function RuntimeWithSession({ children }: { children: ReactNode }) {
  const { currentSessionId, historyTopic, setServerTaskActive } = useSession();
  const mountedRef = useRef(new Set<string>());
  const restoredWatchersRef = useRef(false);

  useEffect(() => {
    if (restoredWatchersRef.current) return;
    restoredWatchersRef.current = true;
    restoreWatchedSessions();
  }, []);

  // Load message history into the store when a session is activated
  useEffect(() => {
    MessageStore.loadHistory(currentSessionId, historyTopic);
    void FileStore.loadSessionFiles(currentSessionId);
    mountedRef.current.add(currentSessionId);

    // Evict old sessions if over limit
    if (mountedRef.current.size > MAX_CACHED) {
      for (const id of mountedRef.current) {
        if (id !== currentSessionId && !StreamManager.isActive(id)) {
          mountedRef.current.delete(id);
          MessageStore.clearMessages(id);
          TaskStore.clearTasks(id);
          break;
        }
      }
    }
  }, [currentSessionId, historyTopic]);

  // Check for active background work on session mount and register with
  // the global task watcher if needed. Also handle stream resumption.
  useEffect(() => {
    let cancelled = false;

    async function initSession() {
      try {
        const status = await getSessionStatus(currentSessionId, historyTopic);
        if (cancelled) return;

        const hasBackgroundWork =
          status.active || status.has_deferred_files || status.has_bg_tasks;

        setServerTaskActive(
          currentSessionId,
          status.has_deferred_files || status.has_bg_tasks,
        );

        // Resume an active stream the server is still working on.
        if (status.active && !StreamManager.isActive(currentSessionId)) {
          MessageStore.ensureStreamingAssistantMessage(
            currentSessionId,
            "Resuming ongoing work...",
            historyTopic,
          );
          resumeSessionStream(currentSessionId, historyTopic);
          window.dispatchEvent(
            new CustomEvent("crew:thinking", {
              detail: {
                thinking: true,
                iteration: 0,
                sessionId: currentSessionId,
                topic: historyTopic,
              },
            }),
          );
        }

        MessageStore.reconcileRecoveredStreamingMessages(
          currentSessionId,
          historyTopic,
          { streamActive: status.active },
        );

        // Register with the global task watcher for background work.
        if (hasBackgroundWork) {
          watchSession(currentSessionId, historyTopic);
        } else {
          unwatchSession(currentSessionId, historyTopic);
        }
      } catch {
        // Non-fatal — session will still work for new messages.
      }
    }

    void initSession();

    // Listen for background task events from SSE and register with watcher.
    function handleBgTasks(event: Event) {
      const detail = (event as CustomEvent).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId) return;
      // Register ANY session with bg tasks, not just the current one.
      watchSession(sessionId, detail?.topic);
    }

    function handleTaskStatus(event: Event) {
      const detail = (event as CustomEvent).detail;
      const sessionId = detail?.sessionId;
      if (!sessionId) return;
      const task = detail?.task as BackgroundTaskInfo | undefined;
      if (task) {
        TaskStore.mergeTask(sessionId, task, detail?.topic);
        watchSession(sessionId, detail?.topic);
      }
    }

    window.addEventListener("crew:bg_tasks", handleBgTasks);
    window.addEventListener("crew:task_status", handleTaskStatus);

    return () => {
      cancelled = true;
      window.removeEventListener("crew:bg_tasks", handleBgTasks);
      window.removeEventListener("crew:task_status", handleTaskStatus);
    };
  }, [currentSessionId, historyTopic, setServerTaskActive]);

  return <>{children}</>;
}

export function OctosRuntimeProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <RuntimeWithSession>{children}</RuntimeWithSession>
    </SessionProvider>
  );
}
