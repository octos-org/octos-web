import { useSyncExternalStore } from "react";
import type { BackgroundTaskInfo } from "@/api/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredTask extends BackgroundTaskInfo {
  /** Monotonic server sequence if the server provides one. */
  server_seq?: number;
  /** RFC3339 timestamp of the most recent update; used as a tiebreaker. */
  updated_at?: string;
}

export interface MergeOptions {
  /** Monotonic server sequence — higher value wins during conflict. */
  serverSeq?: number;
  /** RFC3339 timestamp used as a tiebreaker when server_seq is absent. */
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const tasksByKey = new Map<string, StoredTask[]>();
const listeners = new Set<() => void>();
const snapshots = new Map<string, { version: number; data: BackgroundTaskInfo[] }>();
let allTasksSnapshot:
  | { version: number; data: ReadonlyArray<readonly [string, BackgroundTaskInfo[]]> }
  | null = null;

let version = 0;

function notify() {
  version++;
  snapshots.clear();
  allTasksSnapshot = null;
  for (const listener of listeners) listener();
  scheduleFlush();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sorted(tasks: StoredTask[]): StoredTask[] {
  return [...tasks].sort((a, b) => {
    const aActive = a.status === "spawned" || a.status === "running" ? 1 : 0;
    const bActive = b.status === "spawned" || b.status === "running" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
  });
}

function storeKey(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
}

// ---------------------------------------------------------------------------
// Persistence — localStorage, scoped by profile + session (+ topic)
// ---------------------------------------------------------------------------

const PERSIST_PREFIX = "octos_web:task_store:v1";
const PERSIST_DEBOUNCE_MS = 250;
const PERSIST_MAX_BYTES = 512 * 1024; // 512 KB per (profile, session) entry
const PERSIST_COMPLETED_AGE_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24 h

let activeProfile: string = typeof window !== "undefined"
  ? window.localStorage.getItem("selected_profile") ?? "unknown"
  : "unknown";

function persistKey(profile: string, sessionId: string): string {
  return `${PERSIST_PREFIX}:${profile}:${sessionId}`;
}

/**
 * B-007: a profile id of `unknown`, empty, or falsy means we cannot
 * scope writes to a user. Persisting under `unknown` would bleed tasks
 * across accounts that share the same device. Skip persistence entirely
 * (both write AND read) when the resolved profile is not a real id.
 */
function isPersistableProfile(profile: string | null | undefined): boolean {
  if (!profile) return false;
  const trimmed = profile.trim();
  if (!trimmed) return false;
  if (trimmed === "unknown") return false;
  return true;
}

function canPersist(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

/**
 * Remove any `octos_web:task_store:v1:unknown:*` entries from
 * localStorage. Used when a real profile id becomes available after a
 * previous session wrote under the `unknown` fallback.
 */
function clearUnknownProfileEntries(): void {
  if (!canPersist()) return;
  const prefix = `${PERSIST_PREFIX}:unknown:`;
  const keysToRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith(prefix)) keysToRemove.push(key);
  }
  for (const key of keysToRemove) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

function splitStoreKey(key: string): { sessionId: string; topic?: string } {
  const hashIndex = key.indexOf("#");
  if (hashIndex === -1) return { sessionId: key };
  return { sessionId: key.slice(0, hashIndex), topic: key.slice(hashIndex + 1) };
}

interface PersistedEntry {
  scoped: Record<string, StoredTask[]>;
}

function readPersistedEntry(profile: string, sessionId: string): PersistedEntry | null {
  if (!canPersist()) return null;
  if (!isPersistableProfile(profile)) return null;
  const raw = window.localStorage.getItem(persistKey(profile, sessionId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.scoped || typeof parsed.scoped !== "object") return null;
    return parsed as PersistedEntry;
  } catch (err) {
    // Drop the bad entry — never throw during hydration.
    try {
      window.localStorage.removeItem(persistKey(profile, sessionId));
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-console
    console.warn("[task-store] dropping unparseable persisted entry:", err);
    return null;
  }
}

function writePersistedEntry(profile: string, sessionId: string, entry: PersistedEntry): void {
  if (!canPersist()) return;
  if (!isPersistableProfile(profile)) return;
  const serialized = JSON.stringify(entry);
  // Hard cap: LRU-evict completed tasks older than 24h until we fit.
  if (serialized.length <= PERSIST_MAX_BYTES) {
    try {
      window.localStorage.setItem(persistKey(profile, sessionId), serialized);
    } catch {
      // Quota exhausted — ignore; in-memory state is still correct.
    }
    return;
  }

  const trimmed = evictStaleCompletedTasks(entry);
  try {
    const trimmedSerialized = JSON.stringify(trimmed);
    if (trimmedSerialized.length <= PERSIST_MAX_BYTES) {
      window.localStorage.setItem(persistKey(profile, sessionId), trimmedSerialized);
    } else {
      // Still too large — skip persisting this tick.
    }
  } catch {
    // ignore
  }
}

function evictStaleCompletedTasks(entry: PersistedEntry): PersistedEntry {
  const now = Date.now();
  const scoped: Record<string, StoredTask[]> = {};
  for (const [key, tasks] of Object.entries(entry.scoped)) {
    scoped[key] = tasks.filter((task) => {
      if (task.status === "spawned" || task.status === "running") return true;
      if (task.status === "failed") return true;
      if (!task.completed_at) return true;
      const completedAt = Date.parse(task.completed_at);
      if (Number.isNaN(completedAt)) return true;
      return now - completedAt < PERSIST_COMPLETED_AGE_CUTOFF_MS;
    });
  }
  return { scoped };
}

let flushHandle: ReturnType<typeof setTimeout> | null = null;
const dirtySessionIds = new Set<string>();

function markDirty(sessionId: string): void {
  dirtySessionIds.add(sessionId);
}

function scheduleFlush(): void {
  if (!canPersist()) return;
  if (dirtySessionIds.size === 0) return;
  if (flushHandle !== null) return;
  flushHandle = setTimeout(flushPersistence, PERSIST_DEBOUNCE_MS);
}

function flushPersistence(): void {
  if (flushHandle !== null) {
    clearTimeout(flushHandle);
    flushHandle = null;
  }
  if (!canPersist()) return;
  // B-007: drop dirty bookkeeping but do NOT touch localStorage when the
  // profile is not a real id — we must never write nor remove under the
  // `unknown` scope.
  const ids = [...dirtySessionIds];
  dirtySessionIds.clear();
  if (!isPersistableProfile(activeProfile)) {
    return;
  }
  for (const sessionId of ids) {
    const scoped: Record<string, StoredTask[]> = {};
    for (const [key, tasks] of tasksByKey.entries()) {
      const parsed = splitStoreKey(key);
      if (parsed.sessionId !== sessionId) continue;
      if (tasks.length === 0) continue;
      scoped[key] = tasks;
    }
    if (Object.keys(scoped).length === 0) {
      try {
        window.localStorage.removeItem(persistKey(activeProfile, sessionId));
      } catch {
        // ignore
      }
      continue;
    }
    writePersistedEntry(activeProfile, sessionId, { scoped });
  }
}

// B-005: synchronous flush on `pagehide` (with a `visibilitychange`
// fallback for mobile Safari). Without this, a fast reload fires before
// the 250 ms debounce elapses, leaving the task-store entry unwritten.
// `beforeunload` is blocked on mobile Safari and is intentionally not
// used. The module-level flag prevents double-registration across HMR.
let pagehideListenerRegistered = false;

function registerPagehideFlush(): void {
  if (pagehideListenerRegistered) return;
  if (typeof window === "undefined") return;
  pagehideListenerRegistered = true;
  const onHide = () => {
    if (dirtySessionIds.size === 0) return;
    try {
      flushPersistence();
    } catch {
      // best-effort — never throw during unload
    }
  };
  window.addEventListener("pagehide", onHide);
  // Mobile Safari doesn't always fire `pagehide` reliably on back/forward
  // navigation; watch visibility too. `document` check guards SSR.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") onHide();
    });
  }
}

if (typeof window !== "undefined") {
  registerPagehideFlush();
}

/** Exported for tests — force a synchronous flush. */
export function __flushTaskStorePersistenceForTests(): void {
  flushPersistence();
}

/**
 * Rehydrate the task-store for a given profile+session from localStorage.
 *
 * Called on module load for the current profile+session and again on
 * profile/session switch. Parse errors drop the bad entry and log a warning —
 * never throw.
 *
 * B-007: when the profile transitions from a non-persistable value
 * (falsy / empty / `unknown`) to a real id, purge any lingering
 * `octos_web:task_store:v1:unknown:*` entries so leftover tasks from
 * the pre-login state don't bleed into the user's scope.
 */
export function rehydrateTaskStore(opts: { profile: string; session: string }): void {
  const incomingPersistable = isPersistableProfile(opts.profile);
  const previousPersistable = isPersistableProfile(activeProfile);
  if (incomingPersistable && !previousPersistable) {
    clearUnknownProfileEntries();
  }
  activeProfile = opts.profile;
  if (!incomingPersistable) return;
  const entry = readPersistedEntry(opts.profile, opts.session);
  if (!entry) return;

  let mutated = false;
  for (const [key, tasks] of Object.entries(entry.scoped)) {
    if (!Array.isArray(tasks)) continue;
    if (tasks.length === 0) continue;
    tasksByKey.set(key, sorted(tasks));
    mutated = true;
  }
  if (mutated) {
    version++;
    snapshots.clear();
    allTasksSnapshot = null;
    for (const listener of listeners) listener();
  }
}

// Hydrate once on module load using the current profile and session hints.
if (canPersist()) {
  try {
    const savedSession = window.localStorage.getItem("octos_current_session");
    if (savedSession) {
      rehydrateTaskStore({ profile: activeProfile, session: savedSession });
    }
  } catch {
    // ignore — hydration is best-effort
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function getSnapshot(sessionId: string, topic?: string): BackgroundTaskInfo[] {
  const key = storeKey(sessionId, topic);
  const cached = snapshots.get(key);
  if (cached && cached.version === version) return cached.data;
  const data = tasksByKey.get(key) ?? [];
  snapshots.set(key, { version, data });
  return data;
}

export function getTasks(sessionId: string, topic?: string): BackgroundTaskInfo[] {
  return tasksByKey.get(storeKey(sessionId, topic)) ?? [];
}

export function getTask(
  sessionId: string,
  taskId: string,
  topic?: string,
): BackgroundTaskInfo | undefined {
  return getTasks(sessionId, topic).find((task) => task.id === taskId);
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

export function replaceTasks(
  sessionId: string,
  tasks: BackgroundTaskInfo[],
  topic?: string,
): void {
  tasksByKey.set(storeKey(sessionId, topic), sorted(tasks as StoredTask[]));
  markDirty(sessionId);
  notify();
}

/**
 * Merge an authoritative list of tasks with the existing scoped slice, but
 * keep any locally-known active task that is absent from the incoming list.
 *
 * This guards against the reload-during-active-task bug class (#1): a poll
 * that returns an empty list cannot silently wipe a rehydrated running task
 * whose state lived only in localStorage. Terminal tasks in the store that
 * aren't in the incoming list are dropped, since callers expect poll results
 * to supersede completed bookkeeping.
 */
export function reconcileTasks(
  sessionId: string,
  tasks: BackgroundTaskInfo[],
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const existing = tasksByKey.get(key) ?? [];
  const incomingById = new Map<string, StoredTask>();
  for (const task of tasks) {
    if (task.id) incomingById.set(task.id, task as StoredTask);
  }

  const merged: StoredTask[] = [];
  for (const existingTask of existing) {
    const incoming = existingTask.id ? incomingById.get(existingTask.id) : undefined;
    if (incoming) {
      merged.push({ ...existingTask, ...incoming });
      incomingById.delete(existingTask.id);
      continue;
    }
    // Preserve active tasks whose authoritative source temporarily lost them.
    if (existingTask.status === "spawned" || existingTask.status === "running") {
      merged.push(existingTask);
    }
  }
  for (const leftover of incomingById.values()) {
    merged.push(leftover);
  }

  tasksByKey.set(key, sorted(merged));
  markDirty(sessionId);
  notify();
}

export function mergeTask(
  sessionId: string,
  task: BackgroundTaskInfo,
  topic?: string,
  opts: MergeOptions = {},
): void {
  const key = storeKey(sessionId, topic);
  const tasks = [...(tasksByKey.get(key) ?? [])];
  const index = tasks.findIndex((existing) => existing.id === task.id);

  const incoming: StoredTask = {
    ...task,
    server_seq: opts.serverSeq ?? (task as StoredTask).server_seq,
    updated_at: opts.updatedAt ?? (task as StoredTask).updated_at,
  };

  if (index === -1) {
    tasks.push(incoming);
    tasksByKey.set(key, sorted(tasks));
    markDirty(sessionId);
    notify();
    return;
  }

  const existing = tasks[index];
  const existingSeq = typeof existing.server_seq === "number" ? existing.server_seq : null;
  const incomingSeq = typeof incoming.server_seq === "number" ? incoming.server_seq : null;

  // Conflict resolution: highest server_seq wins; on equal server_seq we
  // tiebreak on updated_at. Without the tiebreak, two sources observing
  // the same sequence but different timestamps would race — last write
  // wins even when it is strictly older than the existing snapshot. We
  // skip only when the incoming updated_at is strictly older; when both
  // updated_at values are equal or both absent, last-write-wins is fine.
  if (existingSeq !== null && incomingSeq !== null) {
    if (incomingSeq < existingSeq) return;
    if (incomingSeq === existingSeq) {
      const existingAt = existing.updated_at ? Date.parse(existing.updated_at) : NaN;
      const incomingAt = incoming.updated_at ? Date.parse(incoming.updated_at) : NaN;
      if (
        Number.isFinite(existingAt) &&
        Number.isFinite(incomingAt) &&
        incomingAt < existingAt
      ) {
        return;
      }
    }
  } else {
    const existingAt = existing.updated_at ? Date.parse(existing.updated_at) : 0;
    const incomingAt = incoming.updated_at ? Date.parse(incoming.updated_at) : Date.now();
    if (
      existingAt > 0 &&
      Number.isFinite(incomingAt) &&
      incomingAt > 0 &&
      incomingAt < existingAt
    ) {
      return;
    }
  }

  tasks[index] = { ...existing, ...incoming };
  tasksByKey.set(key, sorted(tasks));
  markDirty(sessionId);
  notify();
}

export function clearTasks(sessionId: string, topic?: string): void {
  if (topic?.trim()) {
    tasksByKey.delete(storeKey(sessionId, topic));
  } else {
    for (const key of [...tasksByKey.keys()]) {
      if (key === sessionId || key.startsWith(`${sessionId}#`)) {
        tasksByKey.delete(key);
      }
    }
  }
  markDirty(sessionId);
  notify();
}

function getAllTasksSnapshot(): ReadonlyArray<readonly [string, BackgroundTaskInfo[]]> {
  if (allTasksSnapshot && allTasksSnapshot.version === version) {
    return allTasksSnapshot.data;
  }

  const grouped = new Map<string, BackgroundTaskInfo[]>();
  for (const [key, tasks] of tasksByKey.entries()) {
    const { sessionId } = splitStoreKey(key);
    const merged = grouped.get(sessionId) ?? [];
    for (const task of tasks) {
      const existingIndex = merged.findIndex((candidate) => candidate.id === task.id);
      if (existingIndex === -1) {
        merged.push(task);
      } else {
        merged[existingIndex] = { ...merged[existingIndex], ...task };
      }
    }
    grouped.set(sessionId, sorted(merged as StoredTask[]));
  }

  const data = [...grouped.entries()]
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([sessionId, tasks]) => [sessionId, tasks] as const);
  allTasksSnapshot = { version, data };
  return data;
}

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

export function useTasks(sessionId: string, topic?: string): BackgroundTaskInfo[] {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(sessionId, topic),
    () => getSnapshot(sessionId, topic),
  );
}

export function useAllTasksBySession(): ReadonlyArray<readonly [string, BackgroundTaskInfo[]]> {
  return useSyncExternalStore(
    subscribe,
    getAllTasksSnapshot,
    getAllTasksSnapshot,
  );
}
