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
import * as ThreadStore from "@/store/thread-store";
import { getSessionStatus } from "@/api/sessions";
import type { BackgroundTaskInfo } from "@/api/types";
import { restoreWatchedSessions, unwatchSession, watchSession } from "./task-watcher";
import { eventSessionId, eventTopic } from "./event-scope";
import { isChatAppUiV1Enabled } from "@/lib/feature-flags";
import {
  startBridgeForSession,
  stopActiveBridge,
} from "./ui-protocol-runtime";
/** Max sessions kept in memory simultaneously. */
const MAX_CACHED = 5;

/** Last task_status seen per `task.id`. Used to suppress synthesizing a
 *  duplicate progress line on replays/oscillations — only emit a line
 *  when the status actually changes for that task. Per-task scoping
 *  also means two unrelated tasks sharing one `tool_call_id` (rare but
 *  possible across reconnects) each contribute exactly one entry per
 *  transition rather than collapsing into the previous task's line.
 */
const lastTaskStatusById = new Map<string, BackgroundTaskInfo["status"]>();

/** Cap individual task labels and error suffixes so a pathological
 *  payload cannot bloat the in-bubble timeline. The bubble renders
 *  monospace at small text sizes — long single-line failures are
 *  unreadable. */
const MAX_TASK_LABEL_CHARS = 64;
const MAX_PROGRESS_LINE_CHARS = 320;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Display-form a snake_case tool name. Mirrors the simplification in
 *  `session-task-dock.tsx`'s `taskDisplayName` so the same task surfaces
 *  with the same label everywhere ("deep_research" → "deep research").
 *  Capped to a reasonable width. */
function displayTaskName(tool: string): string {
  const stripped = (tool || "task").replace(/_/g, " ").trim();
  return clip(stripped || "task", MAX_TASK_LABEL_CHARS);
}

/** Build a human-readable progress line for a task_status transition.
 *  Returns null when the status carries no useful narration (e.g. the
 *  daemon emitted an unknown status string), or when this exact status
 *  was already seen for this task and a duplicate line should be
 *  suppressed at the source. */
function synthesizeTaskProgressLine(
  task: BackgroundTaskInfo,
): string | null {
  const previous = lastTaskStatusById.get(task.id);
  if (previous === task.status) return null;
  // Record the new status BEFORE returning the line so re-entrant
  // dispatches (within the same tick) can short-circuit on the second
  // call. Failures still record so a `failed -> failed` replay is
  // suppressed too.
  lastTaskStatusById.set(task.id, task.status);

  const label = displayTaskName(task.tool_name);
  switch (task.status) {
    case "spawned":
      return clip(`${label} started`, MAX_PROGRESS_LINE_CHARS);
    case "running":
      return clip(`${label} running`, MAX_PROGRESS_LINE_CHARS);
    case "completed":
      return clip(`${label} completed`, MAX_PROGRESS_LINE_CHARS);
    case "failed": {
      // Single-line normalize the error: collapse newlines/whitespace
      // so the bubble doesn't line-break inside a tiny mono pill.
      const detail = task.error
        ? task.error.replace(/\s+/g, " ").trim()
        : "";
      const line = detail ? `${label} failed: ${detail}` : `${label} failed`;
      return clip(line, MAX_PROGRESS_LINE_CHARS);
    }
    default:
      return null;
  }
}

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

  // Phase C-2 (#68): when the chat_app_ui_v1 flag is on, mount a
  // `ui-protocol-bridge` on top of the existing SSE+REST runtime. The
  // bridge owns the streaming-turn slice; the router fans bridge events
  // out to ThreadStore mutations. Flag-OFF (the default) leaves this
  // effect a no-op so the legacy path is bit-for-bit preserved.
  useEffect(() => {
    if (!isChatAppUiV1Enabled()) return;
    let cancelled = false;
    void (async () => {
      try {
        await startBridgeForSession(currentSessionId, historyTopic);
      } catch {
        // Bridge start failures are surfaced by the bridge's own
        // `warning` events; the SSE path remains operational.
      }
      if (cancelled) {
        // Session changed mid-start; tear down what we just brought up.
        await stopActiveBridge();
      }
    })();
    return () => {
      cancelled = true;
      void stopActiveBridge();
    };
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
        TaskStore.mergeTask(sessionId, task, topic);
        MessageStore.bindBackgroundTask(sessionId, task, topic);
        // Mirror the status as a synthetic progress line into the
        // tool-call's runtime timeline. Background subagents (e.g.
        // deep_research / run_pipeline) emit their per-step
        // `tool_progress` SSE events on the spawned task's own stream,
        // not the parent chat stream — without this mirror the
        // tool-call bubble in the parent thread renders empty even
        // when the task is actively running. Only synthesize a line
        // when the bubble has a stable id to anchor against; the
        // helper de-duplicates consecutive identical entries so we
        // tolerate task_status replays without doubling the timeline.
        const progressLine = synthesizeTaskProgressLine(task);
        if (progressLine && task.tool_call_id) {
          MessageStore.appendToolProgressByCallId(
            sessionId,
            task.tool_call_id,
            progressLine,
            topic,
          );
          // Mirror into the v2 thread store when it already knows
          // about this tool_call_id (i.e. tool_start arrived before
          // task_status). When the lookup misses we deliberately drop
          // the synthetic progress for v2 rather than synthesize an
          // orphan thread — the v1 path is still authoritative until
          // the v2 flag is flipped, and creating phantom threads for
          // every backgrounded task on first paint would race with
          // the real tool_start that arrives moments later.
          const threadId = ThreadStore.findThreadIdForToolCall(
            sessionId,
            topic,
            task.tool_call_id,
          );
          if (threadId) {
            ThreadStore.appendToolProgress(
              threadId,
              task.tool_call_id,
              progressLine,
            );
          }
        }
        const hasActiveTasks = TaskStore.getTasks(sessionId, topic).some(
          (candidate) =>
            candidate.status === "spawned" || candidate.status === "running",
        );
        setServerTaskActive(sessionId, hasActiveTasks);
        watchSession(sessionId, topic);
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
