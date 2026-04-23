/**
 * Typed reducer action vocabulary for runtime bridges.
 *
 * Phase 3+4 requires every runtime surface (sse-bridge, task-watcher,
 * history-replay) to route through reducers instead of poking at the
 * stateful message-store facade directly. This module defines that
 * vocabulary as a set of `apply*` functions. Each one composes a reducer
 * projection with the minimum facade call needed to persist it.
 *
 * Task updates are also mirrored into task-store so the UI can subscribe to
 * authoritative task state from a single place.
 */

import type { BackgroundTaskInfo } from "@/api/types";
import * as MessageStore from "./message-store";
import * as TaskStore from "./task-store";
import type { MessageFile, MessageMeta } from "./message-store";
import { eventSessionId, eventTopic } from "@/runtime/event-scope";

// ---------------------------------------------------------------------------
// Assistant streaming
// ---------------------------------------------------------------------------

export interface AssistantStreamTarget {
  sessionId: string;
  topic?: string;
  messageId: string;
}

export interface AppendAssistantTextAction extends AssistantStreamTarget {
  type: "append_assistant_text";
  chunk: string;
}

export interface ReplaceAssistantTextAction extends AssistantStreamTarget {
  type: "replace_assistant_text";
  text: string;
}

export interface FinalizeAssistantAction extends AssistantStreamTarget {
  type: "finalize_assistant";
  text: string;
  meta?: MessageMeta;
}

export interface StreamErrorAction extends AssistantStreamTarget {
  type: "stream_error";
  errorMessage: string;
  /** When true, the message text is `errorMessage` verbatim instead of "Error: ...". */
  raw?: boolean;
}

export function applyAppendAssistantText(action: AppendAssistantTextAction): void {
  MessageStore.appendText(action.sessionId, action.messageId, action.chunk, action.topic);
}

export function applyReplaceAssistantText(action: ReplaceAssistantTextAction): void {
  MessageStore.updateMessage(
    action.sessionId,
    action.messageId,
    { text: action.text },
    action.topic,
  );
}

export function applyFinalizeAssistant(action: FinalizeAssistantAction): void {
  MessageStore.updateMessage(
    action.sessionId,
    action.messageId,
    { text: action.text, status: "complete" },
    action.topic,
  );
  if (action.meta) {
    MessageStore.setMessageMeta(action.sessionId, action.messageId, action.meta, action.topic);
  }
}

export function applyStreamError(action: StreamErrorAction): void {
  const text = action.raw ? action.errorMessage : `Error: ${action.errorMessage}`;
  MessageStore.updateMessage(
    action.sessionId,
    action.messageId,
    { text, status: "error" },
    action.topic,
  );
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface ToolCallSummary {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
}

export interface UpdateToolCallsAction extends AssistantStreamTarget {
  type: "update_tool_calls";
  toolCalls: ToolCallSummary[];
}

export function applyUpdateToolCalls(action: UpdateToolCallsAction): void {
  MessageStore.updateMessage(
    action.sessionId,
    action.messageId,
    { toolCalls: action.toolCalls },
    action.topic,
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface AppendFileArtifactAction {
  type: "append_file_artifact";
  sessionId: string;
  topic?: string;
  file: MessageFile;
  /** Bind the file to the message that spawned it, when available. */
  toolCallId?: string;
}

/**
 * Attach a file to the message bubble that "owns" it.
 *
 * Routing, in order:
 *   1. toolCallId match (authoritative — file belongs to this tool invocation)
 *   2. background-anchor / output-path match (file belongs to a running task)
 *
 * Returns true when the file was attached somewhere; false when no owner was
 * found and the caller should fall back to other routing (history replay).
 */
export function applyAppendFileArtifact(action: AppendFileArtifactAction): boolean {
  const attachedByToolCall = MessageStore.appendFileByToolCallId(
    action.sessionId,
    action.toolCallId,
    action.file,
    action.topic,
  );
  if (attachedByToolCall) return true;
  return MessageStore.appendFileToBackgroundAnchor(
    action.sessionId,
    action.file,
    action.topic,
  );
}

// ---------------------------------------------------------------------------
// Background tasks — mirror into task-store + project into message-store
// ---------------------------------------------------------------------------

export interface TaskStatusAction {
  type: "task_status";
  sessionId: string;
  topic?: string;
  task: BackgroundTaskInfo;
  /** Server sequence for conflict resolution. Higher wins. */
  serverSeq?: number;
  /** RFC3339 timestamp of this snapshot; used as a tiebreaker. */
  updatedAt?: string;
}

/**
 * Task snapshots are deduplicated/merged inside task-store; this action is the
 * single entry point for any runtime surface that observes a task_status.
 */
export function applyTaskStatus(action: TaskStatusAction): void {
  TaskStore.mergeTask(action.sessionId, action.task, action.topic, {
    serverSeq: action.serverSeq,
    updatedAt: action.updatedAt,
  });
  MessageStore.bindBackgroundTask(action.sessionId, action.task, action.topic);
  MessageStore.ensureTaskAnchor(action.sessionId, action.task, action.topic);
}

// ---------------------------------------------------------------------------
// Background anchor registration (used when an assistant turn spawns bg work)
// ---------------------------------------------------------------------------

export interface RegisterBackgroundAnchorAction {
  type: "register_background_anchor";
  sessionId: string;
  topic?: string;
  messageId: string;
  toolNames: string[];
}

export function applyRegisterBackgroundAnchor(
  action: RegisterBackgroundAnchorAction,
): void {
  MessageStore.registerBackgroundAnchor(
    action.sessionId,
    action.messageId,
    action.topic,
    action.toolNames,
  );
}

// ---------------------------------------------------------------------------
// Scope guard — used by runtime bridges before dispatch
// ---------------------------------------------------------------------------

/**
 * Return true when the event matches the expected session+topic scope.
 * Callers should log/record a scope mismatch when this returns false.
 */
export function isEventInScope(
  event: { session_id?: string; topic?: string } | Record<string, unknown>,
  expected: { sessionId: string; topic?: string },
): boolean {
  const scopedSessionId = eventSessionId(event);
  if (scopedSessionId !== undefined && scopedSessionId !== expected.sessionId) {
    return false;
  }
  const scopedTopic = eventTopic(event);
  const normalizedExpectedTopic = expected.topic?.trim() || undefined;
  if (scopedTopic !== undefined && scopedTopic !== normalizedExpectedTopic) {
    return false;
  }
  return true;
}
