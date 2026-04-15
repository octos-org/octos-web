import { useSyncExternalStore } from "react";
import type { BackgroundTaskInfo } from "@/api/types";

const tasksBySession = new Map<string, BackgroundTaskInfo[]>();
const listeners = new Set<() => void>();
const snapshots = new Map<string, { version: number; data: BackgroundTaskInfo[] }>();
let allTasksSnapshot: { version: number; data: ReadonlyArray<readonly [string, BackgroundTaskInfo[]]> } | null = null;

let version = 0;

function notify() {
  version++;
  snapshots.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function sorted(tasks: BackgroundTaskInfo[]): BackgroundTaskInfo[] {
  return [...tasks].sort((a, b) => {
    const aActive = a.status === "spawned" || a.status === "running" ? 1 : 0;
    const bActive = b.status === "spawned" || b.status === "running" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
  });
}

function getSnapshot(sessionId: string): BackgroundTaskInfo[] {
  const cached = snapshots.get(sessionId);
  if (cached && cached.version === version) return cached.data;
  const data = tasksBySession.get(sessionId) ?? [];
  snapshots.set(sessionId, { version, data });
  return data;
}

export function getTasks(sessionId: string): BackgroundTaskInfo[] {
  return tasksBySession.get(sessionId) ?? [];
}

export function replaceTasks(sessionId: string, tasks: BackgroundTaskInfo[]): void {
  tasksBySession.set(sessionId, sorted(tasks));
  notify();
}

export function mergeTask(sessionId: string, task: BackgroundTaskInfo): void {
  const tasks = [...(tasksBySession.get(sessionId) ?? [])];
  const index = tasks.findIndex((existing) => existing.id === task.id);
  if (index === -1) {
    tasks.push(task);
  } else {
    tasks[index] = { ...tasks[index], ...task };
  }
  tasksBySession.set(sessionId, sorted(tasks));
  notify();
}

export function clearTasks(sessionId: string): void {
  tasksBySession.delete(sessionId);
  notify();
}

function getAllTasksSnapshot(): ReadonlyArray<readonly [string, BackgroundTaskInfo[]]> {
  if (allTasksSnapshot && allTasksSnapshot.version === version) {
    return allTasksSnapshot.data;
  }

  const data = [...tasksBySession.entries()]
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([sessionId, tasks]) => [sessionId, tasks] as const);
  allTasksSnapshot = { version, data };
  return data;
}

export function useTasks(sessionId: string): BackgroundTaskInfo[] {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(sessionId),
    () => getSnapshot(sessionId),
  );
}

export function useAllTasksBySession(): ReadonlyArray<readonly [string, BackgroundTaskInfo[]]> {
  return useSyncExternalStore(
    subscribe,
    getAllTasksSnapshot,
    getAllTasksSnapshot,
  );
}
