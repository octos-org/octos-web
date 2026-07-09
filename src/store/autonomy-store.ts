/**
 * Per-session autonomy state: recurring loops + persisted goal (M15
 * `coding.loop_runtime.v1` / `coding.goal_runtime.v1`).
 *
 * Fed from two directions, same as the task store:
 *   1. Snapshot on (re)connect — the runtime layer calls
 *      `bridge.listLoops()` + `bridge.getGoal()` after `session/open`
 *      and replaces this store's scope.
 *   2. Live notifications — `loop/updated`, `loop/fired`,
 *      `loop/completed`, `session/goal/updated`, `session/goal/cleared`
 *      merge incrementally via the event router.
 *
 * Why this exists: a paused-loop "Re-entering" zombie was invisible on
 * the web — the TUI showed the chip but the SPA had no surface at all,
 * so a runaway or stuck loop could only be found (and stopped) from the
 * terminal. The header chip reading this store is the web's equivalent.
 */

import { useSyncExternalStore } from "react";
import type { UiGoalRecord, UiLoopRecord } from "@/runtime/ui-protocol-types";

export interface AutonomyState {
  loops: UiLoopRecord[];
  goal: UiGoalRecord | null;
}

const EMPTY: AutonomyState = { loops: [], goal: null };

const stateByKey = new Map<string, AutonomyState>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function storeKey(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
}

function scope(key: string): AutonomyState {
  return stateByKey.get(key) ?? EMPTY;
}

export function getAutonomyState(
  sessionId: string,
  topic?: string,
): AutonomyState {
  return scope(storeKey(sessionId, topic));
}

export function replaceLoops(
  sessionId: string,
  loops: UiLoopRecord[],
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  stateByKey.set(key, { ...scope(key), loops: [...loops] });
  notify();
}

/** Merge a live loop record by `loop_id` (insert or replace). A record
 *  whose status is `deleted` is removed instead — the server keeps
 *  emitting the tombstone shape on delete transitions. */
export function upsertLoop(
  sessionId: string,
  loop: UiLoopRecord,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const current = scope(key);
  const rest = current.loops.filter((l) => l.loop_id !== loop.loop_id);
  const next =
    loop.status === "deleted" ? rest : [...rest, loop];
  stateByKey.set(key, { ...current, loops: next });
  notify();
}

export function removeLoop(
  sessionId: string,
  loopId: string,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const current = scope(key);
  stateByKey.set(key, {
    ...current,
    loops: current.loops.filter((l) => l.loop_id !== loopId),
  });
  notify();
}

export function setGoal(
  sessionId: string,
  goal: UiGoalRecord | null,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  stateByKey.set(key, { ...scope(key), goal });
  notify();
}

export function useAutonomyState(
  sessionId: string,
  topic?: string,
): AutonomyState {
  return useSyncExternalStore(
    subscribe,
    () => getAutonomyState(sessionId, topic),
    () => getAutonomyState(sessionId, topic),
  );
}

/** Test helper — clears all scopes. */
export function __resetAutonomyStoreForTest(): void {
  stateByKey.clear();
  notify();
}
