/**
 * Global task watcher — session/topic-scoped background monitor.
 *
 * Uses `/api/sessions/{id}/tasks` + incremental `/api/sessions/{id}/messages`
 * polling for task/result delivery. M9-α-5/α-6 (ADR PR #830 / audit
 * issue #845) deleted the SSE `/api/sessions/{id}/events/stream` stream
 * that previously served as the primary truth path; the WS bridge owns
 * live `task/updated`, `message/persisted`, and per-turn lifecycle
 * notifications now, so the polling fallback is sufficient for the
 * background-only signal this watcher needs (the foreground chat thread
 * never reaches this module).
 */

import {
  getSessionTasks,
  getMessages as fetchSessionMessages,
} from "@/api/sessions";
import { buildApiHeaders } from "@/api/client";
import { API_BASE } from "@/lib/constants";
import * as ThreadStore from "@/store/thread-store";
import * as TaskStore from "@/store/task-store";
import * as FileStore from "@/store/file-store";
import { displayFilenameFromPath } from "@/lib/utils";
import { dispatchCrewFileEvent } from "./file-events";
import { recordRuntimeCounter } from "./observability";
import type { BackgroundTaskInfo, MessageInfo } from "@/api/types";

const POLL_INTERVAL_MS = 2500;
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
  terminalSince: number | null;
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
        ThreadStore.getMaxHistorySeq(entry.sessionId, entry.topic),
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
    ThreadStore.getKnownFilePaths(entry.sessionId, topic),
  );

  watchedSessions.set(key, {
    sessionId: entry.sessionId,
    topic,
    lastCommittedSeq: Math.max(
      entry.lastCommittedSeq,
      ThreadStore.getMaxHistorySeq(entry.sessionId, topic),
    ),
    knownPaths,
    activeIds: new Set(),
    replayComplete: false,
    terminalSince: null,
  });
}

function removeWatchedSession(key: string): void {
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
  for (const m of messages) {
    ThreadStore.appendPersistedMessage(sessionId, entry.topic, m);
  }
  entry.lastCommittedSeq = Math.max(
    entry.lastCommittedSeq,
    ThreadStore.getMaxHistorySeq(sessionId, entry.topic),
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
      ThreadStore.getMaxHistorySeq(sessionId, currentTopic),
    );
    entry.terminalSince = null;
    persistWatchedSessions();
    ensurePolling();
    return;
  }

  seedWatchedSession({
    sessionId,
    topic: currentTopic,
    lastCommittedSeq: ThreadStore.getMaxHistorySeq(sessionId, currentTopic),
  });
  persistWatchedSessions();
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
      dispatchTaskStatusEvent(entry.sessionId, entry.topic, task);
    }
    updateActiveIds(entry, tasks);
    applyCommittedMessages(entry.sessionId, entry, messages);
    entry.replayComplete = true;
    if (entry.activeIds.size === 0 && entry.terminalSince == null) {
      entry.terminalSince = Date.now();
    }

    if (
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
    // Keep watching; the next poll will retry sync.
  }
}
