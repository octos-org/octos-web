/**
 * Runtime provider — manages session lifecycle and authoritative background sync.
 *
 * The runtime layer owns session recovery and background-task polling. UI
 * components read from stores only; they do not drive `/tasks` or `/messages`
 * synchronization themselves.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { SessionProvider, useSession } from "./session-context";
import * as FileStore from "@/store/file-store";
import * as TaskStore from "@/store/task-store";
import * as ThreadStore from "@/store/thread-store";
// The per-session status indicator (active turn, deferred files,
// background tasks) routes through the `getSessionStatus` wrapper,
// which calls the WS `session/status.get` method. The legacy REST
// fallback was retired in M12 Phase D-5 (octos PR #914).
import { getSessionStatus } from "@/api/sessions";
import type { BackgroundTaskInfo } from "@/api/types";
import { restoreWatchedSessions, unwatchSession, watchSession } from "./task-watcher";
import { eventSessionId, eventTopic } from "./event-scope";
import {
  startBridgeForSession,
  stopActiveBridgeIfScope,
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

/** Tracks which sessions have been mounted so we can evict old ones.
 *  Exported as `ScopedRuntimeBridge` so embedded chat surfaces
 *  (slides/sites) can wire the bridge into their own
 *  `SessionContext.Provider` scope without nesting two SessionProviders.
 *  Issue #112.2. */
function RuntimeWithSession({ children }: { children: ReactNode }) {
  const { currentSessionId, historyTopic, setServerTaskActive } = useSession();
  const mountedRef = useRef(new Set<string>());
  const restoredWatchersRef = useRef(false);

  useEffect(() => {
    if (restoredWatchersRef.current) return;
    restoredWatchersRef.current = true;
    restoreWatchedSessions();
  }, []);

  // Load message history into the store when a session is activated.
  // Issue #110.2: `ThreadStore.loadHistory` is now owned by
  // `SessionProvider` (which fires it on mount + switchSession);
  // RuntimeProvider only needs to drive the per-session FileStore
  // and the eviction LRU here. Pre-fix this effect was a duplicate
  // loadHistory call that competed with SessionProvider's load and
  // chat-thread's retry timers, producing 3+ /messages requests on
  // every mount.
  useEffect(() => {
    void FileStore.loadSessionFiles(currentSessionId);
    mountedRef.current.add(currentSessionId);

    // Evict old sessions if over limit. Pre M9-α-5/α-6 the eviction
    // check skipped sessions with an active SSE stream; with the SSE
    // bridge gone, the WS bridge owns lifecycle and we evict freely
    // by recency. The active session is always preserved (`id !==
    // currentSessionId` guard).
    if (mountedRef.current.size > MAX_CACHED) {
      for (const id of mountedRef.current) {
        if (id !== currentSessionId) {
          mountedRef.current.delete(id);
          ThreadStore.clearSession(id);
          TaskStore.clearTasks(id);
          break;
        }
      }
    }
  }, [currentSessionId, historyTopic]);

  // Mount the UI Protocol v1 `ui-protocol-bridge` over WS for every
  // chat session, INCLUDING topic-scoped ones (sites/slides,
  // `/new <topic>`). Issue #112.1: pre-fix the effect short-circuited
  // when `historyTopic` was non-empty, so topic-scoped sends saw
  // `getActiveBridge(sessionId, topic) === null` and failed with
  // "bridge unavailable". The router already passes `topic` through
  // on every event so event-scoping is correct; the M9-β-1 wire
  // shape carries `topic` on `turn/start` so the server processes
  // topic-scoped turns natively.
  useEffect(() => {
    let cancelled = false;
    let mineStarted = false;
    let unsubscribeTitle: (() => void) | null = null;
    void (async () => {
      try {
        const bridge = await startBridgeForSession(
          currentSessionId,
          historyTopic,
        );
        mineStarted = true;
        if (!cancelled) {
          // Issue #113.2: forward server-emitted title updates onto a
          // window event so SessionProvider (and any future cross-tab
          // listener) can patch `titleCache` + `sessions[]` without
          // owning the bridge directly.
          unsubscribeTitle = bridge.onSessionTitleUpdated((e) => {
            if (typeof window === "undefined") return;
            window.dispatchEvent(
              new CustomEvent("crew:session_title_updated", {
                detail: e,
              }),
            );
          });
        }
      } catch {
        // Either a real start failure (surfaced via the bridge's own
        // `warning` events) OR a stale-generation throw (newer call
        // already won and `startBridgeForSession` cleaned up its own
        // orphan). In either case we did NOT publish; leave whatever
        // is currently active (likely the newer effect's bridge) alone.
      }
      if (cancelled && mineStarted) {
        // We successfully published, but the effect was already cancelled
        // mid-resolve. Only stop if WE are still the active scope —
        // a newer effect may have already taken over by now.
        await stopActiveBridgeIfScope(currentSessionId, historyTopic);
      }
    })();
    return () => {
      cancelled = true;
      if (unsubscribeTitle) {
        unsubscribeTitle();
        unsubscribeTitle = null;
      }
      if (mineStarted) {
        // Only tear down our own scope. A newer effect's bridge stays.
        void stopActiveBridgeIfScope(currentSessionId, historyTopic);
      }
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
        // M9-α-5/α-6: the legacy `resumeSessionStream` (SSE) is gone.
        // The WS bridge handles resumption automatically via
        // `session/open`'s replay cursor — when this session re-mounts
        // after a refresh, the bridge's `start()` call dispatches the
        // server's outstanding envelopes back through the projection
        // and ThreadStore catches up without an explicit resume call.
        // M9-γ-6: ThreadStore's orphan-thread path opens the bucket on
        // the first incoming token; no pre-emptive placeholder write.
        if (status.active) {
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

    // Listen for background task events forwarded by the task watcher
    // (polling fallback) and register with the watcher.
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
        // M9-γ-6: bg-task↔message binding lived only in MessageStore.
        // Mirror the status as a synthetic progress line into the
        // ThreadStore's tool-call timeline. Background subagents
        // (e.g. deep_research / run_pipeline) emit their per-step
        // `tool_progress` SSE events on the spawned task's own stream,
        // not the parent chat stream — without this mirror the
        // tool-call bubble in the parent thread renders empty even
        // when the task is actively running. Only synthesize a line
        // when the bubble has a stable id to anchor against; the
        // helper de-duplicates consecutive identical entries so we
        // tolerate task_status replays without doubling the timeline.
        const progressLine = synthesizeTaskProgressLine(task);
        if (progressLine && task.tool_call_id) {
          // Mirror into the thread store when it already knows about
          // this tool_call_id (i.e. tool_start arrived before
          // task_status). When the lookup misses we deliberately drop
          // the synthetic progress rather than synthesize an orphan
          // thread — creating phantom threads for every backgrounded
          // task on first paint would race with the real tool_start
          // that arrives moments later.
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

/** Issue #112.2: mount the runtime bridge / task-watcher / file-store
 *  loaders against an EXISTING `SessionContext.Provider` (e.g. the
 *  slim provider that slides-chat / sites-chat construct manually).
 *  Use this when the caller already owns its session context value
 *  and just needs the bridge wired up. */
export function ScopedRuntimeBridge({ children }: { children: ReactNode }) {
  return <RuntimeWithSession>{children}</RuntimeWithSession>;
}
