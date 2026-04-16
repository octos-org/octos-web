/**
 * Global task watcher — session-independent background task monitor.
 *
 * Tracks sessions with active background tasks and polls for completion.
 * When a task finishes, fetches messages and files for that session to
 * deliver results regardless of which session the user is viewing.
 *
 * This runs outside session context so it survives session switches.
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
import { displayFilenameFromPath } from "@/lib/utils";
import { dispatchCrewFileEvent } from "./file-events";
import type { BackgroundTaskInfo, MessageInfo } from "@/api/types";

const POLL_INTERVAL_MS = 2500;
const POST_COMPLETION_POLLS = 3;

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
  /** Remaining polls after all tasks complete. */
  postCompletionRemaining: number;
  /** Highest committed history sequence applied to the session. */
  lastCommittedSeq: number;
  /** Known file paths — used to detect new files and emit events. */
  knownPaths: Set<string>;
  /** Previous task states — used to detect completion transitions. */
  prevActiveIds: Set<string>;
  /** Dedicated background event stream for this session. */
  eventAbort?: AbortController;
}

const watchedSessions = new Map<string, WatchedSession>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Register a session for background task monitoring. */
export function watchSession(sessionId: string, topic?: string): void {
  const key = watchKey(sessionId, topic);
  if (watchedSessions.has(key)) {
    // Already watched — reset post-completion counter in case new tasks spawned.
    const entry = watchedSessions.get(key)!;
    entry.lastCommittedSeq = Math.max(
      entry.lastCommittedSeq,
      MessageStore.getMaxHistorySeq(sessionId, topic),
    );
    entry.postCompletionRemaining = POST_COMPLETION_POLLS;
    void pollSession(entry);
    return;
  }

  const knownPaths = new Set(
    MessageStore.getMessages(sessionId, topic).flatMap((m) =>
      m.files.map((f) => f.path),
    ),
  );

  watchedSessions.set(key, {
    sessionId,
    topic: topic?.trim() || undefined,
    postCompletionRemaining: POST_COMPLETION_POLLS,
    lastCommittedSeq: MessageStore.getMaxHistorySeq(sessionId, topic),
    knownPaths,
    prevActiveIds: new Set(),
  });

  ensureEventStream(key);
  ensurePolling();
}

/** Stop watching a session (e.g. on session delete). */
export function unwatchSession(sessionId: string, topic?: string): void {
  const key = watchKey(sessionId, topic);
  const entry = watchedSessions.get(key);
  entry?.eventAbort?.abort();
  watchedSessions.delete(key);
  if (watchedSessions.size === 0) stopPolling();
}

function ensurePolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  // Run first poll immediately.
  void pollAll();
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
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
}

function ensureEventStream(key: string): void {
  const entry = watchedSessions.get(key);
  if (!entry || entry.eventAbort) return;

  const abort = new AbortController();
  entry.eventAbort = abort;

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
      const response = await fetch(
        url,
        {
          headers: buildApiHeaders(),
          signal: abort.signal,
        },
      );
      if (!response.ok || !response.body) return;

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
              | { type: string };
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }

            const current = watchedSessions.get(key);
            if (!current) return;

            if (event.type === "task_status" && "task" in event) {
              TaskStore.mergeTask(current.sessionId, event.task);
              current.postCompletionRemaining = POST_COMPLETION_POLLS;
              continue;
            }

            if (event.type === "session_result" && "message" in event) {
              applyCommittedMessages(current.sessionId, current, [event.message]);
              current.postCompletionRemaining = POST_COMPLETION_POLLS;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // Polling remains the fallback when the live background stream is unavailable.
    } finally {
      const current = watchedSessions.get(key);
      if (current && current.eventAbort === abort) {
        current.eventAbort = undefined;
        if (current.prevActiveIds.size > 0 || current.postCompletionRemaining > 0) {
          setTimeout(() => ensureEventStream(key), 1000);
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
    ensureEventStream(key);
    const tasks = await getSessionTasks(entry.sessionId, entry.topic).catch(
      () => [] as BackgroundTaskInfo[],
    );
    TaskStore.replaceTasks(entry.sessionId, tasks);

    const activeIds = new Set(tasks.filter(isTaskActive).map((t) => t.id));
    const hasActive = activeIds.size > 0;

    // Detect tasks that just completed (were active last poll, not anymore).
    const justCompleted = [...entry.prevActiveIds].filter((id) => !activeIds.has(id));
    entry.prevActiveIds = activeIds;

    if (justCompleted.length > 0) {
      // A task just finished — reset counter to ensure we fetch deliverables.
      entry.postCompletionRemaining = POST_COMPLETION_POLLS;
    }

    // Fetch new messages to pick up delivered files.
    const messages = await fetchSessionMessages(
      entry.sessionId,
      500,
      0,
      entry.lastCommittedSeq >= 0 ? entry.lastCommittedSeq : undefined,
      entry.topic,
    );

    applyCommittedMessages(entry.sessionId, entry, messages);

    // Decide whether to keep watching.
    if (hasActive) {
      entry.postCompletionRemaining = POST_COMPLETION_POLLS;
    } else if (entry.postCompletionRemaining > 0) {
      entry.postCompletionRemaining--;
    } else {
      // All tasks terminal, post-completion syncs done — stop watching.
      entry.eventAbort?.abort();
      watchedSessions.delete(key);
      if (watchedSessions.size === 0) stopPolling();
    }
  } catch {
    // Network error — keep watching, will retry next interval.
  }
}
