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
import {
  getMessages as fetchSessionMessages,
  getSessionStatus,
  getSessionTasks,
} from "@/api/sessions";
import { displayFilenameFromPath } from "@/lib/utils";
import type { BackgroundTaskInfo, MessageInfo } from "@/api/types";
import { dispatchCrewFileEvent } from "./file-events";

/** Max sessions kept in memory simultaneously. */
const MAX_CACHED = 5;
const BACKGROUND_SYNC_INTERVAL_MS = 2000;
const BACKGROUND_SYNC_GRACE_MS = 15000;

function isTaskActive(task: BackgroundTaskInfo): boolean {
  return task.status === "spawned" || task.status === "running";
}

function attachmentCaption(content: string): string {
  return /^\s*[✓✗]\s+\S+.*\b(completed|failed|error)\b/iu.test(content.trim())
    ? ""
    : content;
}

function emitNewFileEvents(
  sessionId: string,
  messages: MessageInfo[],
  knownPaths: Set<string>,
): void {
  for (const message of messages) {
    for (const filePath of message.media ?? []) {
      if (knownPaths.has(filePath)) continue;
      knownPaths.add(filePath);
      dispatchCrewFileEvent({
        sessionId,
        path: filePath,
        filename: displayFilenameFromPath(filePath),
        caption: attachmentCaption(message.content ?? ""),
      });
    }
  }
}

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
          TaskStore.clearTasks(id);
          break;
        }
      }
    }
  }, [currentSessionId]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let syncInFlight = false;
    let syncQueued = false;
    let lastBackgroundActivityAt = 0;

    const requestSync = () => {
      if (cancelled) return;
      if (syncInFlight) {
        syncQueued = true;
        return;
      }
      syncInFlight = true;
      void syncSession().finally(() => {
        syncInFlight = false;
        if (syncQueued && !cancelled) {
          syncQueued = false;
          requestSync();
        }
      });
    };

    const scheduleNext = (delayMs = BACKGROUND_SYNC_INTERVAL_MS) => {
      if (cancelled) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(requestSync, delayMs);
    };

    async function syncSession() {
      try {
        await MessageStore.loadHistory(currentSessionId);
        await FileStore.loadSessionFiles(currentSessionId);
        if (cancelled) return;

        const knownPaths = new Set(
          MessageStore.getMessages(currentSessionId).flatMap((message) =>
            message.files.map((file) => file.path),
          ),
        );

        const [status, tasks] = await Promise.all([
          getSessionStatus(currentSessionId),
          getSessionTasks(currentSessionId).catch(() => [] as BackgroundTaskInfo[]),
        ]);
        if (cancelled) return;

        TaskStore.replaceTasks(currentSessionId, tasks);

        if (status.active && !StreamManager.isActive(currentSessionId)) {
          MessageStore.ensureStreamingAssistantMessage(
            currentSessionId,
            "Resuming ongoing work...",
          );
          resumeSessionStream(currentSessionId);
          window.dispatchEvent(
            new CustomEvent("crew:thinking", {
              detail: { thinking: true, iteration: 0, sessionId: currentSessionId },
            }),
          );
        }

        const messages = await fetchSessionMessages(
          currentSessionId,
          500,
          0,
          MessageStore.getMaxHistorySeq(currentSessionId),
        );
        if (cancelled) return;

        if (messages.length > 0) {
          MessageStore.appendHistoryMessages(currentSessionId, messages);
          emitNewFileEvents(currentSessionId, messages, knownPaths);
        }

        const streamActive = StreamManager.isActive(currentSessionId);
        const hasActiveTasks = tasks.some(isTaskActive);
        const hasBackgroundWork =
          status.active || status.has_deferred_files || hasActiveTasks;
        const hasBackgroundIndicatorState = hasActiveTasks || status.has_deferred_files;

        setServerTaskActive(currentSessionId, hasBackgroundIndicatorState);

        if (hasBackgroundWork || streamActive) {
          lastBackgroundActivityAt = Date.now();
        }

        const withinGraceWindow =
          lastBackgroundActivityAt > 0 &&
          Date.now() - lastBackgroundActivityAt < BACKGROUND_SYNC_GRACE_MS;

        if (hasBackgroundWork || streamActive || withinGraceWindow) {
          scheduleNext();
        } else {
          window.dispatchEvent(
            new CustomEvent("crew:thinking", {
              detail: { thinking: false, iteration: 0, sessionId: currentSessionId },
            }),
          );
          setServerTaskActive(currentSessionId, false);
        }
      } catch {
        if (!cancelled) {
          scheduleNext(5000);
        }
      }
    }

    function handleBgTasks(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== currentSessionId) return;
      lastBackgroundActivityAt = Date.now();
      requestSync();
    }

    function handleTaskStatus(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== currentSessionId) return;
      const task = detail?.task as BackgroundTaskInfo | undefined;
      if (task) {
        TaskStore.mergeTask(currentSessionId, task);
        // Extend grace window on ANY task state change — when a task
        // completes, we need the sync loop to keep running long enough
        // to fetch the delivered file from session history.
        lastBackgroundActivityAt = Date.now();
      }
      requestSync();
    }

    function handleStreamState(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== currentSessionId) return;
      if (detail?.active) {
        lastBackgroundActivityAt = Date.now();
      }
      requestSync();
    }

    window.addEventListener("crew:bg_tasks", handleBgTasks);
    window.addEventListener("crew:task_status", handleTaskStatus);
    window.addEventListener("crew:stream_state", handleStreamState);
    requestSync();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      window.removeEventListener("crew:bg_tasks", handleBgTasks);
      window.removeEventListener("crew:task_status", handleTaskStatus);
      window.removeEventListener("crew:stream_state", handleStreamState);
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
