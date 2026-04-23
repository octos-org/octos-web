/**
 * Global task watcher — session/topic-scoped background monitor.
 *
 * Uses the per-session event stream as the primary truth source for
 * task/result delivery. Falls back to `/tasks` + incremental `/messages`
 * polling only while the live stream is unavailable.
 */

import {
  getSessionTasks,
  getMessages as fetchSessionMessages,
} from "@/api/sessions";
import { buildApiHeaders } from "@/api/client";
import { API_BASE } from "@/lib/constants";
import * as MessageStore from "@/store/message-store";
import * as TaskStore from "@/store/task-store";
import * as FileStore from "@/store/file-store";
import { applyTaskStatus, isEventInScope } from "@/store/message-store-actions";
import { displayFilenameFromPath } from "@/lib/utils";
import { dispatchCrewFileEvent } from "./file-events";
import { recordRuntimeCounter } from "./observability";
import type { BackgroundTaskInfo, MessageInfo } from "@/api/types";

const POLL_INTERVAL_MS = 2500;
const STREAM_RETRY_MS = 1000;
const TERMINAL_GRACE_MS = 10_000;
const WATCH_PERSISTENCE_KEY = "octos_task_watcher_sessions_v1";
const WATCH_PERSISTENCE_TTL_MS = 12 * 60 * 60 * 1000;

function watchKey(sessionId: string, topic?: string): string {
  const normalizedTopic = topic?.trim();
  return normalizedTopic ? `${sessionId}::${normalizedTopic}` : sessionId;
}

function isTaskActive(task: BackgroundTaskInfo): boolean {
  return task.status === "spawned" || task.status === "running";
}

interface WatchedSession {
  sessionId: string;
  topic?: string;
  lastCommittedSeq: number;
  knownPaths: Set<string>;
  activeIds: Set<string>;
  replayComplete: boolean;
  streamHealthy: boolean;
  terminalSince: number | null;
  eventAbort?: AbortController;
}

interface PersistedWatchedSession {
  sessionId: string;
  topic?: string;
  lastCommittedSeq: number;
  updatedAt: number;
}

const watchedSessions = new Map<string, WatchedSession>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function canPersistWatchState(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readPersistedSessions(): PersistedWatchedSession[] {
  if (!canPersistWatchState()) return [];
  try {
    const raw = window.localStorage.getItem(WATCH_PERSISTENCE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - WATCH_PERSISTENCE_TTL_MS;
    return parsed.filter((entry): entry is PersistedWatchedSession => {
      if (!entry || typeof entry !== "object") return false;
      if (typeof entry.sessionId !== "string" || !entry.sessionId) return false;
      if (
        typeof entry.lastCommittedSeq !== "number" ||
        !Number.isFinite(entry.lastCommittedSeq)
      ) {
        return false;
      }
      if (typeof entry.updatedAt !== "number" || entry.updatedAt < cutoff) {
        return false;
      }
      return true;
    });
  } catch {
    return [];
  }
}

function persistWatchedSessions(): void {
  if (!canPersistWatchState()) return;
  try {
    const next: PersistedWatchedSession[] = [...watchedSessions.values()].map((entry) => ({
      sessionId: entry.sessionId,
      topic: entry.topic,
      lastCommittedSeq: Math.max(
        entry.lastCommittedSeq,
        MessageStore.getMaxHistorySeq(entry.sessionId, entry.topic),
      ),
      updatedAt: Date.now(),
    }));
    if (next.length === 0) {
      window.localStorage.removeItem(WATCH_PERSISTENCE_KEY);
      return;
    }
    window.localStorage.setItem(WATCH_PERSISTENCE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable or full; keep runtime watcher in memory.
  }
}

function seedWatchedSession(entry: {
  sessionId: string;
  topic?: string;
  lastCommittedSeq: number;
}): void {
  const key = watchKey(entry.sessionId, entry.topic);
  if (watchedSessions.has(key)) return;

  const topic = entry.topic?.trim() || undefined;
  const knownPaths = new Set(
    MessageStore.getMessages(entry.sessionId, topic).flatMap((message) =>
      message.files.map((file) => file.path),
    ),
  );

  watchedSessions.set(key, {
    sessionId: entry.sessionId,
    topic,
    lastCommittedSeq: Math.max(
      entry.lastCommittedSeq,
      MessageStore.getMaxHistorySeq(entry.sessionId, topic),
    ),
    knownPaths,
    activeIds: new Set(),
    replayComplete: false,
    streamHealthy: false,
    terminalSince: null,
  });
}

function removeWatchedSession(key: string): void {
  const entry = watchedSessions.get(key);
  entry?.eventAbort?.abort();
  watchedSessions.delete(key);
  persistWatchedSessions();
  if (watchedSessions.size === 0) stopPolling();
}

function dispatchTaskStatusEvent(
  sessionId: string,
  topic: string | undefined,
  task: BackgroundTaskInfo,
): void {
  window.dispatchEvent(
    new CustomEvent("crew:task_status", {
      detail: { sessionId, topic, task },
    }),
  );
}

function dispatchBgTasksEvent(sessionId: string, topic: string | undefined): void {
  window.dispatchEvent(
    new CustomEvent("crew:bg_tasks", {
      detail: { sessionId, topic },
    }),
  );
}

function updateActiveIds(entry: WatchedSession, tasks: BackgroundTaskInfo[]): void {
  entry.activeIds = new Set(tasks.filter(isTaskActive).map((task) => task.id));
  if (entry.activeIds.size > 0) {
    entry.terminalSince = null;
    dispatchBgTasksEvent(entry.sessionId, entry.topic);
  } else if (entry.replayComplete && entry.terminalSince == null) {
    entry.terminalSince = Date.now();
  }
}

function applyTaskUpdate(entry: WatchedSession, task: BackgroundTaskInfo): void {
  if (isTaskActive(task)) {
    entry.activeIds.add(task.id);
    entry.terminalSince = null;
    dispatchBgTasksEvent(entry.sessionId, entry.topic);
  } else {
    entry.activeIds.delete(task.id);
    if (entry.replayComplete && entry.activeIds.size === 0) {
      entry.terminalSince = Date.now();
    }
  }
}

function emitNewFileEvents(
  sessionId: string,
  topic: string | undefined,
  messages: MessageInfo[],
  knownPaths: Set<string>,
): void {
  for (const message of messages) {
    for (const filePath of message.media ?? []) {
      if (knownPaths.has(filePath)) continue;
      knownPaths.add(filePath);
      dispatchCrewFileEvent({
        sessionId,
        topic,
        path: filePath,
        filename: displayFilenameFromPath(filePath),
        caption: "",
      });
    }
  }
}

function applyCommittedMessages(
  sessionId: string,
  entry: WatchedSession,
  messages: MessageInfo[],
): void {
  if (messages.length === 0) return;
  entry.lastCommittedSeq = Math.max(
    entry.lastCommittedSeq,
    MessageStore.appendHistoryMessages(sessionId, messages, entry.topic),
  );
  emitNewFileEvents(sessionId, entry.topic, messages, entry.knownPaths);
  void FileStore.loadSessionFiles(sessionId);
  if (entry.activeIds.size === 0) {
    entry.terminalSince = Date.now();
  }
  persistWatchedSessions();
}

async function backfillCommittedGap(
  entry: WatchedSession,
  previousSeq: number,
  observedSeq: number,
): Promise<void> {
  if (observedSeq <= previousSeq + 1) return;

  const backfill = await fetchSessionMessages(
    entry.sessionId,
    500,
    0,
    previousSeq >= 0 ? previousSeq : undefined,
    entry.topic,
  );
  applyCommittedMessages(entry.sessionId, entry, backfill);
}

/** Register a session for background monitoring. */
export function watchSession(sessionId: string, topic?: string): void {
  const key = watchKey(sessionId, topic);
  const currentTopic = topic?.trim() || undefined;

  if (watchedSessions.has(key)) {
    const entry = watchedSessions.get(key)!;
    entry.lastCommittedSeq = Math.max(
      entry.lastCommittedSeq,
      MessageStore.getMaxHistorySeq(sessionId, currentTopic),
    );
    entry.terminalSince = null;
    persistWatchedSessions();
    ensureEventStream(key);
    ensurePolling();
    return;
  }

  seedWatchedSession({
    sessionId,
    topic: currentTopic,
    lastCommittedSeq: MessageStore.getMaxHistorySeq(sessionId, currentTopic),
  });
  persistWatchedSessions();
  ensureEventStream(key);
  ensurePolling();
}

/** Stop watching a session/topic. */
export function unwatchSession(sessionId: string, topic?: string): void {
  const key = watchKey(sessionId, topic);
  removeWatchedSession(key);
}

export function restoreWatchedSessions(): void {
  const persisted = readPersistedSessions();
  if (persisted.length === 0) return;

  for (const entry of persisted) {
    seedWatchedSession(entry);
  }
  persistWatchedSessions();
  ensurePolling();
}

function ensurePolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  void pollAll();
}

function stopPolling(): void {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function ensureEventStream(key: string): void {
  const entry = watchedSessions.get(key);
  if (!entry || entry.eventAbort) return;

  const abort = new AbortController();
  entry.eventAbort = abort;
  entry.streamHealthy = false;
  entry.replayComplete = false;

  void (async () => {
    try {
      const params = new URLSearchParams();
      if (entry.lastCommittedSeq >= 0) {
        params.set("since_seq", String(entry.lastCommittedSeq));
      }
      if (entry.topic) {
        params.set("topic", entry.topic);
      }
      const url = `${API_BASE}/api/sessions/${encodeURIComponent(entry.sessionId)}/events/stream${
        params.size > 0 ? `?${params.toString()}` : ""
      }`;
      const response = await fetch(url, {
        headers: buildApiHeaders(),
        signal: abort.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !response.ok ||
        !response.body ||
        !contentType.toLowerCase().includes("text/event-stream")
      ) {
        recordRuntimeCounter("octos_replay_fallback_total", {
          mode: "task_watcher_stream",
          reason: !response.ok
            ? `http_${response.status}`
            : !response.body
              ? "missing_body"
              : "invalid_content_type",
        });
        return;
      }

      entry.streamHealthy = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (!data || data === "[DONE]") continue;

            let event:
              | { type: "task_status"; task: BackgroundTaskInfo }
              | { type: "session_result"; message: MessageInfo }
              | { type: "replay_complete" }
              | { type: string };
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }

            const current = watchedSessions.get(key);
            if (!current) return;

            if (!isEventInScope(event, { sessionId: current.sessionId, topic: current.topic })) {
              recordRuntimeCounter("octos_session_mismatch_total", {
                surface: "task_watcher_stream",
              });
              continue;
            }

            if (event.type === "task_status" && "task" in event) {
              const serverSeq =
                typeof (event as { server_seq?: number }).server_seq === "number"
                  ? (event as { server_seq?: number }).server_seq
                  : undefined;
              const updatedAt =
                typeof (event as { updated_at?: string }).updated_at === "string"
                  ? (event as { updated_at?: string }).updated_at
                  : undefined;
              applyTaskStatus({
                type: "task_status",
                sessionId: current.sessionId,
                topic: current.topic,
                task: event.task,
                serverSeq,
                updatedAt,
              });
              applyTaskUpdate(current, event.task);
              dispatchTaskStatusEvent(current.sessionId, current.topic, event.task);
              continue;
            }

            if (event.type === "session_result" && "message" in event) {
              const previousSeq = current.lastCommittedSeq;
              applyCommittedMessages(current.sessionId, current, [event.message]);
              const observedSeq =
                typeof event.message.seq === "number"
                  ? event.message.seq
                  : current.lastCommittedSeq;
              await backfillCommittedGap(current, previousSeq, observedSeq);
              continue;
            }

            if (event.type === "replay_complete") {
              current.replayComplete = true;
              if (current.activeIds.size === 0) {
                current.terminalSince = Date.now();
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      recordRuntimeCounter("octos_replay_fallback_total", {
        mode: "task_watcher_stream",
        reason: "stream_error",
      });
      // Polling becomes the fallback while the stream is unavailable.
    } finally {
      const current = watchedSessions.get(key);
      if (current && current.eventAbort === abort) {
        current.eventAbort = undefined;
        current.streamHealthy = false;
        persistWatchedSessions();
        if (current.activeIds.size > 0) {
          setTimeout(() => ensureEventStream(key), STREAM_RETRY_MS);
        }
      }
    }
  })();
}

async function pollAll(): Promise<void> {
  const entries = [...watchedSessions.entries()];
  if (entries.length === 0) {
    stopPolling();
    return;
  }

  await Promise.all(entries.map(([, entry]) => pollSession(entry)));
}

async function pollSession(entry: WatchedSession): Promise<void> {
  try {
    const key = watchKey(entry.sessionId, entry.topic);
    if (!entry.eventAbort) {
      ensureEventStream(key);
    }

    // Stream is the primary truth path. Poll while the stream is unavailable,
    // even if a connection attempt is currently in flight. This prevents
    // redirects/HTML fallback responses from starving `/messages` replay.
    if (!entry.streamHealthy) {
      const [tasks, messages] = await Promise.all([
        getSessionTasks(entry.sessionId, entry.topic).catch(
          () => [] as BackgroundTaskInfo[],
        ),
        fetchSessionMessages(
          entry.sessionId,
          500,
          0,
          entry.lastCommittedSeq >= 0 ? entry.lastCommittedSeq : undefined,
          entry.topic,
        ),
      ]);

      TaskStore.replaceTasks(entry.sessionId, tasks, entry.topic);
      for (const task of tasks) {
        // Replay each snapshot through the reducer action so conflict
        // resolution (server_seq / updated_at) stays consistent with SSE
        // arrivals. replaceTasks above has already reset the scoped list;
        // applyTaskStatus refines individual tasks with the full reducer
        // pipeline (message-store task-anchor projection included).
        applyTaskStatus({
          type: "task_status",
          sessionId: entry.sessionId,
          topic: entry.topic,
          task,
        });
        dispatchTaskStatusEvent(entry.sessionId, entry.topic, task);
      }
      updateActiveIds(entry, tasks);
      applyCommittedMessages(entry.sessionId, entry, messages);
      entry.replayComplete = true;
      if (entry.activeIds.size === 0 && entry.terminalSince == null) {
        entry.terminalSince = Date.now();
      }
    }

    if (
      entry.replayComplete &&
      entry.activeIds.size === 0 &&
      entry.terminalSince != null &&
      Date.now() - entry.terminalSince >= TERMINAL_GRACE_MS
    ) {
      removeWatchedSession(key);
    }
  } catch {
    recordRuntimeCounter("octos_replay_fallback_total", {
      mode: "task_watcher_poll",
      reason: "poll_error",
    });
    // Keep watching; the next poll will retry fallback sync.
  }
}
