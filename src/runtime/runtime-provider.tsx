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
import { applyAppendFileArtifact, applyTaskStatus } from "@/store/message-store-actions";
import { getSessionStatus } from "@/api/sessions";
import type { BackgroundTaskInfo } from "@/api/types";
import { restoreWatchedSessions, unwatchSession, watchSession } from "./task-watcher";
import { eventSessionId, eventTopic } from "./event-scope";
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
      const sessionId = eventSessionId(detail);
      if (!sessionId) return;
      const topic = eventTopic(detail);
      setServerTaskActive(sessionId, true);
      // Register ANY session with bg tasks, not just the current one.
      watchSession(sessionId, topic);
    }

    function handleTaskStatus(event: Event) {
      const detail = (event as CustomEvent).detail;
      const sessionId = eventSessionId(detail);
      if (!sessionId) return;
      const topic = eventTopic(detail);
      const task = detail?.task as BackgroundTaskInfo | undefined;
      if (task) {
        const serverSeq =
          typeof detail?.server_seq === "number"
            ? (detail.server_seq as number)
            : typeof (task as { server_seq?: number }).server_seq === "number"
              ? (task as { server_seq?: number }).server_seq
              : undefined;
        const updatedAt =
          typeof detail?.updated_at === "string"
            ? (detail.updated_at as string)
            : typeof (task as { updated_at?: string }).updated_at === "string"
              ? (task as { updated_at?: string }).updated_at
              : undefined;
        applyTaskStatus({
          type: "task_status",
          sessionId,
          topic,
          task,
          serverSeq,
          updatedAt,
        });
        const hasActiveTasks = TaskStore.getTasks(sessionId, topic).some(
          (candidate) =>
            candidate.status === "spawned" || candidate.status === "running",
        );
        setServerTaskActive(sessionId, hasActiveTasks);
        watchSession(sessionId, topic);
      }
    }

    function handleFile(event: Event) {
      const detail = (event as CustomEvent).detail;
      const sessionId = eventSessionId(detail);
      if (!sessionId) return;
      const topic = eventTopic(detail);
      const path = typeof detail?.path === "string" ? detail.path : "";
      const filename = typeof detail?.filename === "string" ? detail.filename : "";
      if (!path || !filename) return;
      const toolCallId =
        typeof detail?.tool_call_id === "string" ? detail.tool_call_id : undefined;
      applyAppendFileArtifact({
        type: "append_file_artifact",
        sessionId,
        topic,
        file: {
          path,
          filename,
          caption: typeof detail?.caption === "string" ? detail.caption : "",
        },
        toolCallId,
      });
    }

    window.addEventListener("crew:bg_tasks", handleBgTasks);
    window.addEventListener("crew:task_status", handleTaskStatus);
    window.addEventListener("crew:file", handleFile);

    return () => {
      cancelled = true;
      window.removeEventListener("crew:bg_tasks", handleBgTasks);
      window.removeEventListener("crew:task_status", handleTaskStatus);
      window.removeEventListener("crew:file", handleFile);
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
