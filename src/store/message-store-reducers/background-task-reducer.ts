import type { BackgroundTaskInfo } from "../../api/types";
import type {
  Message,
  MessageRuntime,
  MessageRuntimeStatus,
  TaskAnchorMeta,
} from "../message-store";
import type { Now } from "./shared";
import {
  findMessageIndexById,
  uniqueStrings,
  withRuntime,
} from "./shared";

export interface ProjectTaskAnchorEvent {
  type: "project_task_anchor";
  sessionId: string;
  task: BackgroundTaskInfo;
  list: Message[];
  taskAnchor: TaskAnchorMeta;
  current?: Message;
  now?: Now;
}

export function taskAnchorMessageId(sessionId: string, taskId: string): string {
  return `task:${sessionId}:${taskId}`;
}

export function taskTimestamp(task: BackgroundTaskInfo, now: Now = Date.now): number {
  const startedAt = new Date(task.started_at).getTime();
  return Number.isFinite(startedAt) ? startedAt : now();
}

export function taskIdentity(task: BackgroundTaskInfo | null | undefined): string | null {
  const id = typeof task?.id === "string" ? task.id.trim() : "";
  return id || null;
}

export function taskAnchorTimelineTimestamp(
  list: Message[],
  task: BackgroundTaskInfo,
  now: Now = Date.now,
): number {
  const serverTs = taskTimestamp(task, now);
  // Guard against client/server clock skew: the anchor bubble must never sort
  // ahead of the user prompt that spawned IT specifically. Earlier revision
  // walked for the LATEST user message, which incorrectly promoted older
  // tasks above newer user turns. Correct behaviour: find the user message
  // whose timestamp most-recently-precedes the task's server-reported
  // started_at, and bump the anchor to just after THAT user — never past
  // a later user turn.
  let triggeringUserTs = -Infinity;
  for (const message of list) {
    if (message.role !== "user") continue;
    if (message.timestamp > serverTs) continue;
    if (message.timestamp > triggeringUserTs) {
      triggeringUserTs = message.timestamp;
    }
  }
  if (!Number.isFinite(triggeringUserTs)) {
    // No preceding user turn (e.g. task started before any user prompt, rare);
    // fall back to the oldest user turn to avoid floating above everything.
    let earliestUserTs = Infinity;
    for (const message of list) {
      if (message.role !== "user") continue;
      if (message.timestamp < earliestUserTs) {
        earliestUserTs = message.timestamp;
      }
    }
    if (Number.isFinite(earliestUserTs) && serverTs < earliestUserTs) {
      return earliestUserTs + 1;
    }
    return serverTs;
  }
  // Always clamp to [triggeringUserTs+1, next-user-turn-1] so multi-task
  // timelines stay interleaved correctly.
  let nextUserTs = Infinity;
  for (const message of list) {
    if (message.role !== "user") continue;
    if (message.timestamp <= triggeringUserTs) continue;
    if (message.timestamp < nextUserTs) {
      nextUserTs = message.timestamp;
    }
  }
  const lowerBound = triggeringUserTs + 1;
  const upperBound = Number.isFinite(nextUserTs) ? nextUserTs - 1 : Number.POSITIVE_INFINITY;
  if (serverTs < lowerBound) return lowerBound;
  if (serverTs > upperBound) return upperBound;
  return serverTs;
}

function sameStrings(left: string[] | undefined, right: string[] | undefined): boolean {
  const normalizedLeft = uniqueStrings(left ?? []);
  const normalizedRight = uniqueStrings(right ?? []);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function sameTaskAnchorMeta(
  left: TaskAnchorMeta | undefined,
  right: TaskAnchorMeta | undefined,
): boolean {
  return (
    left?.taskId === right?.taskId &&
    left?.toolCallId === right?.toolCallId &&
    left?.taskStartedAt === right?.taskStartedAt &&
    left?.taskStatus === right?.taskStatus &&
    left?.lifecycleState === right?.lifecycleState &&
    left?.currentPhase === right?.currentPhase &&
    left?.progressMessage === right?.progressMessage &&
    left?.progress === right?.progress &&
    left?.completedAt === right?.completedAt &&
    left?.error === right?.error &&
    left?.workflowKind === right?.workflowKind &&
    sameStrings(left?.outputFiles, right?.outputFiles) &&
    sameStrings(left?.toolNames, right?.toolNames) &&
    sameJson(left?.progressEvents, right?.progressEvents) &&
    sameJson(left?.runtimeDetail, right?.runtimeDetail)
  );
}

export function mergeTaskAnchorMeta(
  existing: TaskAnchorMeta | undefined,
  task: BackgroundTaskInfo,
): TaskAnchorMeta {
  const normalizedToolName = normalizeToolName(task.tool_name) || task.tool_name;
  return {
    taskId: task.id || existing?.taskId,
    toolCallId: task.tool_call_id ?? existing?.toolCallId,
    taskStartedAt: task.started_at ?? existing?.taskStartedAt,
    taskStatus: task.status ?? existing?.taskStatus,
    lifecycleState: task.lifecycle_state ?? existing?.lifecycleState,
    currentPhase: task.current_phase ?? existing?.currentPhase,
    progressMessage: task.progress_message ?? existing?.progressMessage,
    progress: task.progress ?? existing?.progress,
    progressEvents: task.progress_events ?? existing?.progressEvents,
    runtimeDetail: task.runtime_detail ?? existing?.runtimeDetail,
    completedAt: task.completed_at ?? existing?.completedAt,
    error: task.error ?? existing?.error,
    workflowKind: task.workflow_kind ?? existing?.workflowKind,
    outputFiles: uniqueStrings([...(existing?.outputFiles ?? []), ...(task.output_files ?? [])]),
    toolNames: uniqueStrings([...(existing?.toolNames ?? []), normalizedToolName]),
  };
}

export function normalizeToolName(name: string | undefined): string {
  if (!name) return "";
  return name === "Direct TTS" ? "fm_tts" : name;
}

export function runtimeStatusForTask(task: BackgroundTaskInfo): MessageRuntimeStatus {
  switch (task.status) {
    case "spawned":
    case "running":
      return "ongoing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

export function isTaskActive(task: BackgroundTaskInfo): boolean {
  return task.status === "spawned" || task.status === "running";
}

export function taskMessageStatus(task: BackgroundTaskInfo): Message["status"] {
  if (task.status === "failed") return "error";
  if (isTaskActive(task)) return "streaming";
  return "complete";
}

export function taskRuntimeOverrides(task: BackgroundTaskInfo): Partial<MessageRuntime> {
  return {
    type: "background_task",
    status: runtimeStatusForTask(task),
    taskId: task.id,
    toolCallId: task.tool_call_id,
    phase: task.current_phase ?? task.lifecycle_state ?? null,
    detail: task.progress_message ?? task.error ?? null,
  };
}

export function projectTaskAnchorMessage(
  sessionId: string,
  task: BackgroundTaskInfo,
  list: Message[],
  taskAnchor: TaskAnchorMeta,
  current?: Message,
  now: Now = Date.now,
): Message {
  const taskId = taskIdentity(task) ?? "";
  const base = current
    ? {
        ...current,
        id: taskAnchorMessageId(sessionId, taskId),
        role: current.role === "system" ? "assistant" : current.role,
        kind: "task_anchor" as const,
        status: taskMessageStatus(task),
        timestamp: taskAnchorTimelineTimestamp(list, task, now),
        sourceToolCallId: task.tool_call_id ?? current.sourceToolCallId,
        taskAnchor,
      }
    : {
        id: taskAnchorMessageId(sessionId, taskId),
        role: "assistant" as const,
        kind: "task_anchor" as const,
        text: "",
        files: [],
        toolCalls: [],
        status: taskMessageStatus(task),
        timestamp: taskAnchorTimelineTimestamp(list, task, now),
        sourceToolCallId: task.tool_call_id,
        taskAnchor,
      };

  return withRuntime(base, taskRuntimeOverrides(task), now);
}

export function reduceProjectTaskAnchorEvent(event: ProjectTaskAnchorEvent): Message {
  return projectTaskAnchorMessage(
    event.sessionId,
    event.task,
    event.list,
    event.taskAnchor,
    event.current,
    event.now,
  );
}

export function findTaskAnchorIndex(
  sessionId: string,
  taskMessageIds: ReadonlyMap<string, string> | undefined,
  list: Message[],
  task: BackgroundTaskInfo,
): number {
  const taskId = taskIdentity(task);
  if (!taskId) return -1;
  const anchorId = taskAnchorMessageId(sessionId, taskId);
  const directIndex = findMessageIndexById(list, anchorId);
  if (directIndex !== -1) return directIndex;

  if (taskMessageIds?.has(taskId)) {
    const mappedIndex = findMessageIndexById(list, taskMessageIds.get(taskId)!);
    if (mappedIndex !== -1) return mappedIndex;
  }

  return -1;
}
