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
import * as MessageStore from "@/store/message-store";
import * as TaskStore from "@/store/task-store";
import * as FileStore from "@/store/file-store";
import { displayFilenameFromPath } from "@/lib/utils";
import { dispatchCrewFileEvent } from "./file-events";
import type { BackgroundTaskInfo, MessageInfo } from "@/api/types";

const POLL_INTERVAL_MS = 2500;
const POST_COMPLETION_POLLS = 3;

function isTaskActive(task: BackgroundTaskInfo): boolean {
  return task.status === "spawned" || task.status === "running";
}

interface WatchedSession {
  /** Remaining polls after all tasks complete. */
  postCompletionRemaining: number;
  /** Known file paths — used to detect new files and emit events. */
  knownPaths: Set<string>;
  /** Previous task states — used to detect completion transitions. */
  prevActiveIds: Set<string>;
}

const watchedSessions = new Map<string, WatchedSession>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Register a session for background task monitoring. */
export function watchSession(sessionId: string): void {
  if (watchedSessions.has(sessionId)) {
    // Already watched — reset post-completion counter in case new tasks spawned.
    const entry = watchedSessions.get(sessionId)!;
    entry.postCompletionRemaining = POST_COMPLETION_POLLS;
    return;
  }

  const knownPaths = new Set(
    MessageStore.getMessages(sessionId).flatMap((m) =>
      m.files.map((f) => f.path),
    ),
  );

  watchedSessions.set(sessionId, {
    postCompletionRemaining: POST_COMPLETION_POLLS,
    knownPaths,
    prevActiveIds: new Set(),
  });

  ensurePolling();
}

/** Stop watching a session (e.g. on session delete). */
export function unwatchSession(sessionId: string): void {
  watchedSessions.delete(sessionId);
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
        caption: "",
      });
    }
  }
}

async function pollAll(): Promise<void> {
  const entries = [...watchedSessions.entries()];
  if (entries.length === 0) {
    stopPolling();
    return;
  }

  await Promise.all(entries.map(([sessionId, entry]) => pollSession(sessionId, entry)));
}

async function pollSession(sessionId: string, entry: WatchedSession): Promise<void> {
  try {
    const tasks = await getSessionTasks(sessionId).catch(() => [] as BackgroundTaskInfo[]);
    TaskStore.replaceTasks(sessionId, tasks);

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
      sessionId,
      500,
      0,
      MessageStore.getMaxHistorySeq(sessionId),
    );

    if (messages.length > 0) {
      MessageStore.appendHistoryMessages(sessionId, messages);
      emitNewFileEvents(sessionId, messages, entry.knownPaths);
    }

    // Also refresh file store for the file panel.
    void FileStore.loadSessionFiles(sessionId);

    // Decide whether to keep watching.
    if (hasActive) {
      entry.postCompletionRemaining = POST_COMPLETION_POLLS;
    } else if (entry.postCompletionRemaining > 0) {
      entry.postCompletionRemaining--;
    } else {
      // All tasks terminal, post-completion syncs done — stop watching.
      watchedSessions.delete(sessionId);
      if (watchedSessions.size === 0) stopPolling();
    }
  } catch {
    // Network error — keep watching, will retry next interval.
  }
}
