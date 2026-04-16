import { useSyncExternalStore } from "react";
import type { BackgroundTaskInfo } from "@/api/types";

const tasksByKey = new Map<string, BackgroundTaskInfo[]>();
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

function storeKey(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
}

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

export function replaceTasks(
  sessionId: string,
  tasks: BackgroundTaskInfo[],
  topic?: string,
): void {
  tasksByKey.set(storeKey(sessionId, topic), sorted(tasks));
  notify();
}

export function mergeTask(
  sessionId: string,
  task: BackgroundTaskInfo,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const tasks = [...(tasksByKey.get(key) ?? [])];
  const index = tasks.findIndex((existing) => existing.id === task.id);
  if (index === -1) {
    tasks.push(task);
  } else {
    tasks[index] = { ...tasks[index], ...task };
  }
  tasksByKey.set(key, sorted(tasks));
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
  notify();
}

function getAllTasksSnapshot(): ReadonlyArray<readonly [string, BackgroundTaskInfo[]]> {
  if (allTasksSnapshot && allTasksSnapshot.version === version) {
    return allTasksSnapshot.data;
  }

  const grouped = new Map<string, BackgroundTaskInfo[]>();
  for (const [key, tasks] of tasksByKey.entries()) {
    const sessionId = key.split("#")[0];
    const merged = grouped.get(sessionId) ?? [];
    for (const task of tasks) {
      const existingIndex = merged.findIndex((candidate) => candidate.id === task.id);
      if (existingIndex === -1) {
        merged.push(task);
      } else {
        merged[existingIndex] = { ...merged[existingIndex], ...task };
      }
    }
    grouped.set(sessionId, sorted(merged));
  }

  const data = [...grouped.entries()]
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([sessionId, tasks]) => [sessionId, tasks] as const);
  allTasksSnapshot = { version, data };
  return data;
}

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
