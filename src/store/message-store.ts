/**
 * Message store — session/topic-scoped message state with React integration.
 *
 * Follows the same useSyncExternalStore pattern as file-store.ts.
 * Messages are keyed by sessionId plus optional history topic. History is
 * loaded from the API on first access; streaming updates arrive via the
 * runtime bridges.
 *
 * Pure reducer logic lives in ./message-store-reducers/*. This file keeps the
 * stateful facade — session/topic maps, React subscriptions, and observability
 * counters — but delegates message-shape transformations to the reducers for
 * isolated unit testing.
 */

import { useSyncExternalStore } from "react";
import { getMessages as fetchMessages } from "@/api/sessions";
import type { BackgroundTaskInfo, MessageInfo } from "@/api/types";
import { addFile as addToFileStore } from "@/store/file-store";
import { recordRuntimeCounter } from "@/runtime/observability";
import {
  addFileToMessage,
  convertApiMessage,
  createLocalMessage,
  findFileResultTargetIndex,
  findMessageIndexById,
  findMessageIndexByToolCallId,
  findNoSeqDuplicateIndex,
  findOptimisticMatchIndex,
  findTaskAnchorIndex,
  mergeAuthoritativeIntoMessage,
  mergeFileResultIntoTarget,
  mergeMessageFiles,
  mergeTaskAnchorMeta,
  normalizeMessageText,
  pathMatchKeys,
  projectTaskAnchorMessage,
  reduceAppendAssistantTextEvent,
  reduceAppendFileArtifactEvent,
  reduceCreateAssistantTurnEvent,
  reduceCreateUserMessageEvent,
  reduceEnsureStreamingAssistantEvent,
  reduceReplaceHistoryEvent,
  reduceStopStreamingAssistantEvent,
  runtimeStatusForTask,
  sameTaskAnchorMeta,
  shouldCollapseAuthoritativeDuplicate,
  sortedMessagesForDisplay,
  taskAnchorMessageId,
  taskIdentity,
  taskMessageStatus,
  withRuntime,
  TASK_COMPLETION_RE,
} from "@/store/message-store-reducer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallInfo {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  detail?: string;
}

export interface MessageFile {
  filename: string;
  path: string;
  caption?: string;
}

export interface MessageMeta {
  model: string;
  tokens_in: number;
  tokens_out: number;
  duration_s: number;
}

export type MessageRuntimeType = "user" | "assistant" | "system" | "background_task";
export type MessageRuntimeStatus =
  | "queued"
  | "ongoing"
  | "completed"
  | "stopped"
  | "failed";

export interface MessageRuntime {
  type: MessageRuntimeType;
  status: MessageRuntimeStatus;
  updatedAt: number;
  taskId?: string;
  toolCallId?: string;
  phase?: string | null;
  detail?: string | null;
}

export interface TaskAnchorMeta {
  taskId?: string;
  toolCallId?: string;
  taskStartedAt?: string;
  taskStatus?: BackgroundTaskInfo["status"];
  lifecycleState?: string | null;
  currentPhase?: string | null;
  progressMessage?: string | null;
  progress?: number | null;
  progressEvents?: BackgroundTaskInfo["progress_events"];
  runtimeDetail?: BackgroundTaskInfo["runtime_detail"];
  completedAt?: string | null;
  error?: string | null;
  workflowKind?: string | null;
  outputFiles?: string[];
  toolNames?: string[];
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  kind?: "task_anchor";
  clientMessageId?: string;
  responseToClientMessageId?: string;
  files: MessageFile[];
  toolCalls: ToolCallInfo[];
  status: "streaming" | "complete" | "error" | "stopped";
  runtime?: MessageRuntime;
  timestamp: number;
  historySeq?: number;
  meta?: MessageMeta;
  sourceToolCallId?: string;
  taskAnchor?: TaskAnchorMeta;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const messagesByKey = new Map<string, Message[]>();
const listeners = new Set<() => void>();
/** Track which sessions have already loaded history from the API. */
const loadedSessions = new Set<string>();
/** Track in-flight history loads to avoid duplicate requests. */
const loadingPromises = new Map<string, Promise<void>>();

interface BackgroundAnchor {
  messageId: string;
  toolNames: Set<string>;
  createdAt: number;
}

const backgroundAnchorsByKey = new Map<string, BackgroundAnchor[]>();
const taskMessageByKey = new Map<string, Map<string, string>>();
const toolCallMessageByKey = new Map<string, Map<string, string>>();
const outputPathMessageByKey = new Map<string, Map<string, string>>();

let version = 0;
// Snapshot cache keyed by session/topic key — invalidated on every notify().
const messageSnapshots = new Map<string, { version: number; data: Message[] }>();

function notify() {
  version++;
  messageSnapshots.clear();
  for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function storeKey(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
}

function getMessageSnapshot(sessionId: string, topic?: string): Message[] {
  const key = storeKey(sessionId, topic);
  const cached = messageSnapshots.get(key);
  if (cached && cached.version === version) return cached.data;
  const data = messagesByKey.get(key) ?? [];
  messageSnapshots.set(key, { version, data });
  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

function getList(sessionId: string, topic?: string): Message[] {
  const key = storeKey(sessionId, topic);
  let list = messagesByKey.get(key);
  if (!list) {
    list = [];
    messagesByKey.set(key, list);
  }
  return list;
}

function historyLoadKey(sessionId: string, topic?: string): string {
  return storeKey(sessionId, topic);
}

function normalizeToolName(name: string | undefined): string {
  if (!name) return "";
  return name === "Direct TTS" ? "fm_tts" : name;
}

function isTaskActive(task: BackgroundTaskInfo): boolean {
  return task.status === "spawned" || task.status === "running";
}

function taskToolStatus(
  task: BackgroundTaskInfo,
): ToolCallInfo["status"] {
  if (task.status === "failed") return "error";
  if (isTaskActive(task)) return "running";
  return "complete";
}

function mapFor(
  root: Map<string, Map<string, string>>,
  key: string,
): Map<string, string> {
  let map = root.get(key);
  if (!map) {
    map = new Map();
    root.set(key, map);
  }
  return map;
}

function trimBackgroundAnchors(key: string): void {
  const anchors = backgroundAnchorsByKey.get(key);
  if (!anchors) return;
  const cutoff = Date.now() - 60 * 60_000;
  const kept = anchors.filter((anchor) => anchor.createdAt >= cutoff);
  if (kept.length > 24) kept.splice(0, kept.length - 24);
  if (kept.length === 0) {
    backgroundAnchorsByKey.delete(key);
  } else {
    backgroundAnchorsByKey.set(key, kept);
  }
}

function indexToolCallForMessage(key: string, toolCallId: string, messageId: string): void {
  if (!toolCallId) return;
  mapFor(toolCallMessageByKey, key).set(toolCallId, messageId);
}

function indexTaskForMessage(key: string, task: BackgroundTaskInfo, messageId: string): void {
  mapFor(taskMessageByKey, key).set(task.id, messageId);
  if (task.tool_call_id) {
    indexToolCallForMessage(key, task.tool_call_id, messageId);
  }
  const outputMap = mapFor(outputPathMessageByKey, key);
  for (const path of task.output_files ?? []) {
    for (const pathKey of pathMatchKeys(path)) {
      outputMap.set(pathKey, messageId);
    }
  }
}

function findMessageIndexForFilePath(key: string, list: Message[], file: MessageFile): number {
  const outputMap = outputPathMessageByKey.get(key);
  if (!outputMap) return -1;

  for (const pathKey of pathMatchKeys(file.path)) {
    const messageId = outputMap.get(pathKey);
    if (!messageId) continue;
    const index = findMessageIndexById(list, messageId);
    if (index !== -1) return index;
  }
  return -1;
}

function findBackgroundAnchorIndex(
  key: string,
  list: Message[],
  toolName?: string,
): number {
  trimBackgroundAnchors(key);
  const normalizedToolName = normalizeToolName(toolName);
  const anchors = backgroundAnchorsByKey.get(key);
  if (!anchors) return -1;

  for (let i = anchors.length - 1; i >= 0; i -= 1) {
    const anchor = anchors[i];
    if (
      normalizedToolName &&
      anchor.toolNames.size > 0 &&
      !anchor.toolNames.has(normalizedToolName)
    ) {
      continue;
    }
    const index = findMessageIndexById(list, anchor.messageId);
    if (index !== -1) return index;
  }

  return -1;
}

function findRecentAssistantIndex(list: Message[], beforeTimestamp?: number): number {
  const cutoff = Date.now() - 30 * 60_000;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message.role !== "assistant") continue;
    if (message.files.length > 0) continue;
    if (message.timestamp < cutoff) continue;
    if (beforeTimestamp && message.timestamp > beforeTimestamp + 5_000) continue;
    return index;
  }
  return -1;
}

function upsertToolCall(
  message: Message,
  toolCall: ToolCallInfo,
): Message {
  const existingById = message.toolCalls.findIndex((tc) => tc.id === toolCall.id);
  if (existingById !== -1) {
    const nextToolCalls = [...message.toolCalls];
    nextToolCalls[existingById] = { ...nextToolCalls[existingById], ...toolCall };
    return { ...message, toolCalls: nextToolCalls };
  }

  const existingLocalByName = message.toolCalls.findIndex(
    (tc) => tc.name === toolCall.name && tc.id.startsWith("tc_"),
  );
  if (existingLocalByName !== -1) {
    const nextToolCalls = [...message.toolCalls];
    nextToolCalls[existingLocalByName] = toolCall;
    return { ...message, toolCalls: nextToolCalls };
  }

  return { ...message, toolCalls: [...message.toolCalls, toolCall] };
}

function indexFilesForMessage(sessionId: string, message: Message): void {
  for (const file of message.files) {
    addToFileStore({
      sessionId,
      filename: file.filename,
      filePath: file.path,
      caption: file.caption ?? "",
    });
  }
}

function indexFilesForSession(
  sessionId: string,
  messages: Message[],
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  for (const message of messages) {
    indexFilesForMessage(sessionId, message);
    if (message.sourceToolCallId) {
      indexToolCallForMessage(key, message.sourceToolCallId, message.id);
    }
    for (const toolCall of message.toolCalls) {
      indexToolCallForMessage(key, toolCall.id, message.id);
    }
  }
}

function replaceHistoryFromApi(
  sessionId: string,
  apiMessages: MessageInfo[],
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const existing = messagesByKey.get(key) ?? [];

  const { messages } = reduceReplaceHistoryEvent({
    type: "replace_history_from_api",
    existing,
    apiMessages,
    outputPathMessageIds: outputPathMessageByKey.get(key),
    createId: nextId,
  });

  messagesByKey.set(key, messages);
  indexFilesForSession(sessionId, messages, topic);
  loadedSessions.add(key);
  notify();
}

// ---------------------------------------------------------------------------
// Public API — mutators
// ---------------------------------------------------------------------------

/** Add a new message and return its id. */
export function addMessage(
  sessionId: string,
  msg: Omit<Message, "id" | "timestamp">,
  topic?: string,
): string {
  const id = nextId();
  const key = storeKey(sessionId, topic);
  const list = getList(sessionId, topic);
  const message =
    msg.role === "user"
      ? reduceCreateUserMessageEvent({
          type: "create_user_message",
          message: { ...msg, role: "user" },
          createId: () => id,
        })
      : msg.role === "assistant"
        ? reduceCreateAssistantTurnEvent({
            type: "create_assistant_turn",
            message: { ...msg, role: "assistant" },
            createId: () => id,
          })
        : createLocalMessage(msg, () => id);
  list.push(message);
  // Replace the array reference so React picks up the change
  messagesByKey.set(key, [...list]);
  notify();
  return id;
}

/** Update fields on an existing message. */
export function updateMessage(
  sessionId: string,
  messageId: string,
  updates: Partial<
    Pick<
      Message,
      "text" | "status" | "files" | "toolCalls" | "meta" | "sourceToolCallId"
    >
  >,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  list[idx] = withRuntime({ ...list[idx], ...updates });
  if (updates.toolCalls) {
    for (const toolCall of updates.toolCalls) {
      indexToolCallForMessage(key, toolCall.id, messageId);
    }
  }
  if (updates.sourceToolCallId) {
    indexToolCallForMessage(key, updates.sourceToolCallId, messageId);
  }
  messagesByKey.set(key, [...list]);
  notify();
}

export function setMessageMeta(
  sessionId: string,
  messageId: string,
  meta: MessageMeta,
  topic?: string,
): void {
  updateMessage(sessionId, messageId, { meta }, topic);
}

/** Finalise any still-streaming assistant bubbles (e.g. on user stop). */
export function stopStreamingMessages(sessionId: string, topic?: string): void {
  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return;

  let changed = false;
  const next = list.map((message) => {
    const projected = reduceStopStreamingAssistantEvent({
      type: "stop_streaming_assistant",
      message,
    });
    if (projected !== message) changed = true;
    return projected;
  });

  if (!changed) return;
  messagesByKey.set(key, next);
  notify();
}

/** Append text to a streaming message. */
export function appendText(
  sessionId: string,
  messageId: string,
  chunk: string,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  list[idx] = reduceAppendAssistantTextEvent({
    type: "append_assistant_text",
    message: list[idx],
    chunk,
  });
  messagesByKey.set(key, [...list]);
  notify();
}

/** Append a file to a message, de-duplicating by path. */
export function appendFile(
  sessionId: string,
  messageId: string,
  file: MessageFile,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  const msg = list[idx];
  if (msg.files.some((f) => f.path === file.path)) return;
  list[idx] = reduceAppendFileArtifactEvent({
    type: "append_file_artifact",
    message: msg,
    file,
  });
  messagesByKey.set(key, [...list]);
  addToFileStore({
    sessionId,
    filename: file.filename,
    filePath: file.path,
    caption: file.caption ?? "",
  });
  notify();
}

/**
 * Project a background task's current state into a task_anchor bubble.
 *
 * Creates or updates the anchor message for the task, merging runtime detail
 * and ensuring the timestamp anchors to the task's started_at timestamp.
 */
export function ensureTaskAnchor(
  sessionId: string,
  task: BackgroundTaskInfo,
  topic?: string,
): string | null {
  const taskId = taskIdentity(task);
  if (!taskId) return null;
  const key = storeKey(sessionId, topic);
  const list = getList(sessionId, topic);
  const anchorId = taskAnchorMessageId(sessionId, taskId);
  const targetIndex = findTaskAnchorIndex(
    sessionId,
    taskMessageByKey.get(key),
    list,
    task,
  );
  const nextTaskAnchor = mergeTaskAnchorMeta(
    targetIndex !== -1 ? list[targetIndex].taskAnchor : undefined,
    task,
  );

  if (targetIndex !== -1) {
    const current = list[targetIndex];
    if (
      current.id === anchorId &&
      current.kind === "task_anchor" &&
      current.status === taskMessageStatus(task) &&
      current.sourceToolCallId === (task.tool_call_id ?? current.sourceToolCallId) &&
      current.runtime?.status === runtimeStatusForTask(task) &&
      sameTaskAnchorMeta(current.taskAnchor, nextTaskAnchor)
    ) {
      return anchorId;
    }
  }

  if (targetIndex === -1) {
    list.push(projectTaskAnchorMessage(sessionId, task, list, nextTaskAnchor));
  } else {
    list[targetIndex] = projectTaskAnchorMessage(
      sessionId,
      task,
      list,
      nextTaskAnchor,
      list[targetIndex],
    );
  }

  indexTaskForMessage(key, task, anchorId);
  messagesByKey.set(key, sortedMessagesForDisplay(list));
  notify();
  return anchorId;
}

/**
 * Register a background-task anchor tied to an assistant message id.
 *
 * Used by the SSE/WS bridges when they create the assistant bubble that will
 * later be enriched with tool-call progress and file attachments. The anchor
 * metadata is consulted by the file/tool-call routers to find the right
 * bubble to attach to.
 */
export function registerBackgroundAnchor(
  sessionId: string,
  messageId: string,
  topic?: string,
  toolNames: string[] = [],
): void {
  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list?.some((message) => message.id === messageId)) return;

  trimBackgroundAnchors(key);
  const anchors = backgroundAnchorsByKey.get(key) ?? [];
  const existing = anchors.find((anchor) => anchor.messageId === messageId);
  const normalizedToolNames = toolNames.map(normalizeToolName).filter(Boolean);

  if (existing) {
    for (const toolName of normalizedToolNames) {
      existing.toolNames.add(toolName);
    }
    existing.createdAt = Date.now();
  } else {
    anchors.push({
      messageId,
      toolNames: new Set(normalizedToolNames),
      createdAt: Date.now(),
    });
  }

  backgroundAnchorsByKey.set(key, anchors);
}

export function bindBackgroundTask(
  sessionId: string,
  task: BackgroundTaskInfo,
  topic?: string,
): string | null {
  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return null;

  const normalizedToolName = normalizeToolName(task.tool_name);
  const taskMap = taskMessageByKey.get(key);
  let targetIndex = taskMap?.has(task.id)
    ? findMessageIndexById(list, taskMap.get(task.id)!)
    : -1;

  if (targetIndex === -1) {
    targetIndex = findMessageIndexByToolCallId(list, task.tool_call_id);
  }
  if (targetIndex === -1) {
    targetIndex = findBackgroundAnchorIndex(key, list, normalizedToolName);
  }
  if (targetIndex === -1 && isTaskActive(task)) {
    targetIndex = findRecentAssistantIndex(list);
  }
  if (targetIndex === -1) return null;

  const target = list[targetIndex];
  const toolCallId = task.tool_call_id || `task_${task.id}`;
  list[targetIndex] = upsertToolCall(target, {
    id: toolCallId,
    name: normalizedToolName || task.tool_name || "background_task",
    status: taskToolStatus(task),
  });

  indexTaskForMessage(key, task, list[targetIndex].id);
  messagesByKey.set(key, [...list]);
  notify();
  return list[targetIndex].id;
}

export function appendFileByToolCallId(
  sessionId: string,
  toolCallId: string | undefined,
  file: MessageFile,
  topic?: string,
): boolean {
  if (!toolCallId) return false;

  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return false;

  const mappedMessageId = toolCallMessageByKey.get(key)?.get(toolCallId);
  let targetIndex = mappedMessageId
    ? findMessageIndexById(list, mappedMessageId)
    : -1;
  if (targetIndex === -1) {
    targetIndex = findMessageIndexByToolCallId(list, toolCallId);
  }
  if (targetIndex === -1) return false;

  const next = addFileToMessage(list[targetIndex], file);
  if (next === list[targetIndex]) return true;

  list[targetIndex] = next;
  messagesByKey.set(key, [...list]);
  indexFilesForMessage(sessionId, next);
  notify();
  return true;
}

export function appendFileToBackgroundAnchor(
  sessionId: string,
  file: MessageFile,
  topic?: string,
): boolean {
  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return false;

  let targetIndex = findMessageIndexForFilePath(key, list, file);
  if (targetIndex === -1) {
    targetIndex = findBackgroundAnchorIndex(key, list);
  }
  if (targetIndex === -1) return false;

  const next = addFileToMessage(list[targetIndex], file);
  if (next === list[targetIndex]) return true;

  list[targetIndex] = next;
  messagesByKey.set(key, [...list]);
  indexFilesForMessage(sessionId, next);
  notify();
  return true;
}

/** Get messages for a session (snapshot, not reactive). */
export function getMessages(sessionId: string, topic?: string): Message[] {
  return messagesByKey.get(storeKey(sessionId, topic)) ?? [];
}

/** Clear all messages for a session (e.g. on session delete). */
export function clearMessages(sessionId: string, topic?: string): void {
  const key = storeKey(sessionId, topic);
  if (topic?.trim()) {
    messagesByKey.delete(key);
    backgroundAnchorsByKey.delete(key);
    taskMessageByKey.delete(key);
    toolCallMessageByKey.delete(key);
    outputPathMessageByKey.delete(key);
  } else {
    for (const messageKey of [...messagesByKey.keys()]) {
      if (messageKey === sessionId || messageKey.startsWith(`${sessionId}#`)) {
        messagesByKey.delete(messageKey);
        backgroundAnchorsByKey.delete(messageKey);
        taskMessageByKey.delete(messageKey);
        toolCallMessageByKey.delete(messageKey);
        outputPathMessageByKey.delete(messageKey);
      }
    }
  }
  for (const loadedKey of [...loadedSessions]) {
    if (loadedKey === key || (!topic && loadedKey.startsWith(`${sessionId}#`))) {
      loadedSessions.delete(loadedKey);
    }
  }
  for (const loadingKey of [...loadingPromises.keys()]) {
    if (loadingKey === key || (!topic && loadingKey.startsWith(`${sessionId}#`))) {
      loadingPromises.delete(loadingKey);
    }
  }
  notify();
}

export function getMaxHistorySeq(sessionId: string, topic?: string): number {
  return getMessages(sessionId, topic).reduce((maxSeq, message) => {
    if (typeof message.historySeq !== "number") return maxSeq;
    return Math.max(maxSeq, message.historySeq);
  }, -1);
}

export function replaceHistory(
  sessionId: string,
  apiMessages: MessageInfo[],
  topic?: string,
): void {
  replaceHistoryFromApi(sessionId, apiMessages, topic);
}

export function appendHistoryMessages(
  sessionId: string,
  apiMessages: MessageInfo[],
  topic?: string,
): number {
  if (apiMessages.length === 0) return getMaxHistorySeq(sessionId, topic);

  const key = storeKey(sessionId, topic);
  const list = getList(sessionId, topic);
  let changed = false;
  let maxSeq = getMaxHistorySeq(sessionId, topic);

  for (const apiMessage of apiMessages) {
    const converted = convertApiMessage(apiMessage, nextId);
    if (!converted) continue;
    if (
      typeof converted.historySeq === "number" &&
      list.some((message) => message.historySeq === converted.historySeq)
    ) {
      recordRuntimeCounter("octos_result_duplicate_suppressed_total", {
        kind: converted.role,
        reason: "history_seq",
      });
      maxSeq = Math.max(maxSeq, converted.historySeq);
      continue;
    }

    const fileResultTargetIndex = findFileResultTargetIndex(
      outputPathMessageByKey.get(key),
      list,
      converted,
    );
    if (fileResultTargetIndex !== -1) {
      list[fileResultTargetIndex] = mergeFileResultIntoTarget(
        list[fileResultTargetIndex],
        converted,
      );
      if (converted.sourceToolCallId) {
        indexToolCallForMessage(
          key,
          converted.sourceToolCallId,
          list[fileResultTargetIndex].id,
        );
      }
      if (typeof converted.historySeq === "number") {
        maxSeq = Math.max(maxSeq, converted.historySeq);
      }
      changed = true;
      recordRuntimeCounter("octos_result_duplicate_suppressed_total", {
        kind: converted.role,
        reason: "background_file_coalesced",
      });
      continue;
    }

    const optimisticMatchIndex = findOptimisticMatchIndex(list, converted);
    if (optimisticMatchIndex !== -1) {
      const optimistic = list[optimisticMatchIndex];
      list[optimisticMatchIndex] = mergeAuthoritativeIntoMessage(optimistic, converted);
      if (typeof converted.historySeq === "number") {
        maxSeq = Math.max(maxSeq, converted.historySeq);
      }
      changed = true;
      continue;
    }

    // Safety: check if a message with the same text+role already exists,
    // either as a confirmed (seq'd) entry or as a live-streamed no-seq
    // bubble. When an authoritative historySeq message arrives and matches
    // an existing no-seq bubble, merge the seq into it instead of appending
    // a second copy. This catches the speculative-overflow-replay case
    // where seq=N session_result arrives after the live SSE bubble already
    // rendered the same text.
    const confirmedDupe = list.findIndex(
      (m) =>
        m.role === converted.role &&
        m.files.length === 0 &&
        converted.files.length === 0 &&
        normalizeMessageText(m.text) === normalizeMessageText(converted.text) &&
        typeof converted.historySeq === "number" &&
        m.historySeq !== converted.historySeq &&
        Math.abs(m.timestamp - converted.timestamp) < 120_000,
    );
    if (confirmedDupe !== -1) {
      const existing = list[confirmedDupe];
      // If the existing entry has no historySeq, adopt the new one's seq
      // so future replays/polls dedup via the primary seq guard above.
      if (typeof existing.historySeq !== "number" && typeof converted.historySeq === "number") {
        list[confirmedDupe] = { ...existing, historySeq: converted.historySeq };
        changed = true;
      }
      recordRuntimeCounter("octos_result_duplicate_suppressed_total", {
        kind: converted.role,
        reason: "confirmed_text_match",
      });
      if (typeof converted.historySeq === "number") {
        maxSeq = Math.max(maxSeq, converted.historySeq);
      }
      continue;
    }

    // Final dedup: messages without a historySeq slip past the seq guard and
    // the confirmed-text check (both require typeof historySeq === "number").
    // Legacy replay / skill events occasionally emit MessageInfo with no seq,
    // which re-appends on every poll (the "已记住 ..." reappear bug).
    if (findNoSeqDuplicateIndex(list, converted) !== -1) {
      recordRuntimeCounter("octos_result_duplicate_suppressed_total", {
        kind: converted.role,
        reason: "no_seq_text_match",
      });
      continue;
    }

    list.push(converted);
    if (typeof converted.historySeq === "number") {
      maxSeq = Math.max(maxSeq, converted.historySeq);
    }
    changed = true;
  }

  if (changed) {
    const sorted = sortedMessagesForDisplay(list);
    messagesByKey.set(key, sorted);
    indexFilesForSession(sessionId, sorted, topic);
    loadedSessions.add(key);
    notify();
  }

  return maxSeq;
}

export function mergeHistoryMessageIntoMessage(
  sessionId: string,
  messageId: string,
  apiMessage: MessageInfo,
  topic?: string,
): boolean {
  const converted = convertApiMessage(apiMessage, nextId);
  if (!converted) return false;

  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return false;

  let targetIndex = list.findIndex((message) => message.id === messageId);
  if (targetIndex === -1) return false;

  const fileResultTargetIndex = findFileResultTargetIndex(
    outputPathMessageByKey.get(key),
    list,
    converted,
  );
  if (fileResultTargetIndex !== -1) {
    list[fileResultTargetIndex] = mergeFileResultIntoTarget(
      list[fileResultTargetIndex],
      converted,
    );
    if (converted.sourceToolCallId) {
      indexToolCallForMessage(
        key,
        converted.sourceToolCallId,
        list[fileResultTargetIndex].id,
      );
    }
    messagesByKey.set(key, [...list]);
    indexFilesForSession(sessionId, list, topic);
    loadedSessions.add(key);
    notify();
    return true;
  }

  const target = list[targetIndex];
  if (target.role !== converted.role) return false;

  if (
    typeof converted.historySeq === "number" &&
    typeof target.historySeq === "number" &&
    target.historySeq === converted.historySeq
  ) {
    return true;
  }

  list[targetIndex] = mergeAuthoritativeIntoMessage(target, converted);

  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (index === targetIndex) continue;
    const candidate = list[index];
    if (!shouldCollapseAuthoritativeDuplicate(candidate, list[targetIndex])) continue;

    list[targetIndex] = {
      ...list[targetIndex],
      files: mergeMessageFiles(list[targetIndex].files, candidate.files),
      toolCalls:
        list[targetIndex].toolCalls.length > 0
          ? list[targetIndex].toolCalls
          : candidate.toolCalls,
      meta: list[targetIndex].meta ?? candidate.meta,
    };
    list.splice(index, 1);
    recordRuntimeCounter("octos_result_duplicate_suppressed_total", {
      kind: converted.role,
      reason: "merge_history_duplicate",
    });
    if (index < targetIndex) {
      targetIndex -= 1;
    }
  }

  const sorted = sortedMessagesForDisplay(list);
  messagesByKey.set(key, sorted);
  indexFilesForSession(sessionId, sorted, topic);
  loadedSessions.add(key);
  notify();
  return true;
}

/**
 * Ensure a visible in-progress assistant bubble exists for a session.
 *
 * Used after page reload when the server is still working but the transient
 * streaming UI state was lost.
 */
export function ensureStreamingAssistantMessage(
  sessionId: string,
  text = "Resuming ongoing work...",
  topic?: string,
): string {
  const key = storeKey(sessionId, topic);
  const list = getList(sessionId, topic);
  const projected = reduceEnsureStreamingAssistantEvent({
    type: "ensure_streaming_assistant",
    messages: list,
    text,
    createId: nextId,
  });

  if (projected.changed) {
    messagesByKey.set(key, projected.messages);
    notify();
  }
  return projected.messageId;
}

function isResumePlaceholderText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed === "Resuming ongoing work...";
}

/**
 * Cleanup helper for reload recovery.
 *
 * When the browser reloads during an active turn, we may recreate a transient
 * streaming assistant bubble before the authoritative session state finishes
 * hydrating. Once the runtime knows whether the server is still actively
 * streaming, reconcile those local-only bubbles so they do not linger as
 * ghost turns indefinitely.
 */
export function reconcileRecoveredStreamingMessages(
  sessionId: string,
  topic?: string,
  options?: {
    streamActive?: boolean;
  },
): void {
  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list || list.length === 0) return;

  const keepStreamingId = options?.streamActive
    ? [...list]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            message.status === "streaming" &&
            typeof message.historySeq !== "number",
        )?.id
    : undefined;

  let changed = false;
  const next: Message[] = [];

  for (const message of list) {
    if (
      message.role !== "assistant" ||
      message.status !== "streaming" ||
      typeof message.historySeq === "number"
    ) {
      next.push(message);
      continue;
    }

    if (keepStreamingId && message.id === keepStreamingId) {
      next.push(message);
      continue;
    }

    const hasMeaningfulState =
      !isResumePlaceholderText(message.text) ||
      message.files.length > 0 ||
      message.toolCalls.length > 0;

    if (!options?.streamActive && !hasMeaningfulState) {
      changed = true;
      recordRuntimeCounter("octos_recovery_stream_cleanup_total", {
        action: "drop_placeholder",
      });
      continue;
    }

    next.push(
      withRuntime({
        ...message,
        text:
          !options?.streamActive && isResumePlaceholderText(message.text)
            ? ""
            : message.text,
        status: "complete",
      }),
    );
    changed = true;
    recordRuntimeCounter("octos_recovery_stream_cleanup_total", {
      action: "finalize_orphan",
    });
  }

  if (!changed) return;

  messagesByKey.set(key, next);
  notify();
}

// Re-exported for consumers that need direct access to the shared sentinel.
export { TASK_COMPLETION_RE };

// ---------------------------------------------------------------------------
// History loading
// ---------------------------------------------------------------------------

/**
 * Load message history from the API for a session.
 * No-ops if already loaded. Safe to call multiple times concurrently.
 */
export function loadHistory(sessionId: string, topic?: string): Promise<void> {
  const loadKey = historyLoadKey(sessionId, topic);
  if (loadedSessions.has(loadKey)) return Promise.resolve();

  const existing = loadingPromises.get(loadKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const apiMessages = await fetchMessages(sessionId, 500, 0, undefined, topic);
      const existingMessages = messagesByKey.get(loadKey) ?? [];
      const hasAuthoritativeHistory = existingMessages.some(
        (message) => typeof message.historySeq === "number",
      );
      // Topic-scoped surfaces like slides/site should always replace with
      // authoritative topic history. Generic chat also needs authoritative
      // hydration after reload if the only local state is an optimistic resume
      // placeholder or transient stream error bubble.
      if (topic?.trim()) {
        replaceHistoryFromApi(sessionId, apiMessages, topic);
      } else if (
        !messagesByKey.has(loadKey) ||
        existingMessages.length === 0 ||
        !hasAuthoritativeHistory
      ) {
        replaceHistoryFromApi(sessionId, apiMessages, topic);
      }
      loadedSessions.add(loadKey);
    } catch {
      // API unavailable — not fatal, store stays empty. Leave the key
      // reloadable so a transient fetch failure does not permanently pin the
      // session to an empty message store for the rest of the tab lifetime.
      loadedSessions.delete(loadKey);
    } finally {
      loadingPromises.delete(loadKey);
    }
  })();

  loadingPromises.set(loadKey, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/** Subscribe to messages for a specific session. */
export function useMessages(sessionId: string, topic?: string): Message[] {
  return useSyncExternalStore(
    subscribe,
    () => getMessageSnapshot(sessionId, topic),
    () => getMessageSnapshot(sessionId, topic),
  );
}
