import type { MessageInfo } from "../../api/types";
import type { Message, ToolCallInfo } from "../message-store";
import { displayFilenameFromPath } from "../../lib/utils";
import type { CreateMessageId, Now } from "./shared";
import {
  mergeMessageFiles,
  normalizeMessageText,
  TASK_COMPLETION_RE,
  withRuntime,
} from "./shared";
import { parseLegacyFileDeliveries } from "./file-artifact-reducer";

export interface ConvertHistoryReplayMessageEvent {
  type: "convert_history_replay_message";
  message: MessageInfo;
  createId: CreateMessageId;
  now?: Now;
}

export interface MergeAuthoritativeHistoryMessageEvent {
  type: "merge_authoritative_history_message";
  existing: Message;
  authoritative: Message;
  now?: Now;
}

export function shouldCollapseAuthoritativeDuplicate(
  candidate: Message,
  authoritative: Message,
): boolean {
  if (candidate.kind === "task_anchor") return false;
  if (candidate.role !== authoritative.role) return false;

  if (
    typeof candidate.historySeq === "number" &&
    typeof authoritative.historySeq === "number" &&
    candidate.historySeq === authoritative.historySeq
  ) {
    return true;
  }

  if (
    authoritative.clientMessageId &&
    candidate.clientMessageId === authoritative.clientMessageId
  ) {
    return true;
  }

  if (
    authoritative.responseToClientMessageId &&
    candidate.responseToClientMessageId === authoritative.responseToClientMessageId
  ) {
    return true;
  }

  if (candidate.role !== "assistant") return false;

  const timeDelta = Math.abs(candidate.timestamp - authoritative.timestamp);
  if (timeDelta > 15 * 60_000) return false;

  if (candidate.status === "streaming") return true;

  const candidateText = normalizeMessageText(candidate.text);
  const authoritativeText = normalizeMessageText(authoritative.text);
  return candidateText.length > 0 && candidateText === authoritativeText;
}

export function findOptimisticMatchIndex(list: Message[], authoritative: Message): number {
  if (authoritative.clientMessageId) {
    const directMatchIndex = list.findIndex(
      (candidate) =>
        typeof candidate.historySeq !== "number" &&
        candidate.kind !== "task_anchor" &&
        candidate.role === authoritative.role &&
        candidate.clientMessageId === authoritative.clientMessageId,
    );
    if (directMatchIndex !== -1) return directMatchIndex;
  }

  if (authoritative.responseToClientMessageId) {
    const responseMatchIndex = list.findIndex(
      (candidate) =>
        typeof candidate.historySeq !== "number" &&
        candidate.kind !== "task_anchor" &&
        candidate.role === authoritative.role &&
        candidate.responseToClientMessageId === authoritative.responseToClientMessageId,
    );
    if (responseMatchIndex !== -1) return responseMatchIndex;
  }

  if (authoritative.role === "assistant") {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const candidate = list[index];
      if (typeof candidate.historySeq === "number") continue;
      if (candidate.kind === "task_anchor") continue;
      if (candidate.role !== "assistant" || candidate.status !== "streaming") continue;

      const timeDelta = Math.abs(candidate.timestamp - authoritative.timestamp);
      if (timeDelta > 15 * 60_000) continue;

      // Recovery can replay the committed session_result before the resumed
      // streaming bubble receives its final `done` payload. In that window the
      // texts differ ("Resuming..." vs final answer), but they still represent
      // the same assistant turn and must collapse into one message.
      return index;
    }
  }

  const authoritativeText = normalizeMessageText(authoritative.text);
  const authoritativeTime = authoritative.timestamp;

  let bestIndex = -1;
  let bestTimeDelta = Number.MAX_SAFE_INTEGER;

  for (let index = 0; index < list.length; index += 1) {
    const candidate = list[index];
    if (typeof candidate.historySeq === "number") continue;
    if (candidate.kind === "task_anchor") continue;
    if (candidate.role !== authoritative.role) continue;
    if (normalizeMessageText(candidate.text) !== authoritativeText) continue;
    // Don't require file or tool call match — both arrive asynchronously
    // via SSE and may differ from the API version.

    const timeDelta = Math.abs(candidate.timestamp - authoritativeTime);
    // Recovery can recreate an optimistic assistant bubble and then replay the
    // committed session_result much later. Keep a wider assistant merge window
    // so resumed turns are replaced in place instead of appending a duplicate
    // assistant bubble after one or more reloads.
    const optimisticWindowMs =
      candidate.role === "assistant" ? 15 * 60_000 : 60_000;
    if (timeDelta > optimisticWindowMs) continue;
    if (timeDelta >= bestTimeDelta) continue;

    bestIndex = index;
    bestTimeDelta = timeDelta;
  }

  return bestIndex;
}

export function mergeAuthoritativeIntoMessage(
  existing: Message,
  authoritative: Message,
  now: Now = Date.now,
): Message {
  const merged: Message = {
    ...existing,
    text: authoritative.text,
    clientMessageId: authoritative.clientMessageId ?? existing.clientMessageId,
    responseToClientMessageId:
      authoritative.responseToClientMessageId ?? existing.responseToClientMessageId,
    files: mergeMessageFiles(authoritative.files, existing.files),
    toolCalls:
      authoritative.toolCalls.length > 0 ? authoritative.toolCalls : existing.toolCalls,
    status: "complete",
    timestamp: authoritative.timestamp,
    historySeq: authoritative.historySeq,
    meta: existing.meta,
    sourceToolCallId: authoritative.sourceToolCallId ?? existing.sourceToolCallId,
    kind: existing.kind ?? authoritative.kind,
    taskAnchor: existing.taskAnchor ?? authoritative.taskAnchor,
  };
  return withRuntime(merged, {}, now);
}

export function reduceMergeAuthoritativeHistoryMessageEvent(
  event: MergeAuthoritativeHistoryMessageEvent,
): Message {
  return mergeAuthoritativeIntoMessage(event.existing, event.authoritative, event.now);
}

export function convertApiMessage(
  m: MessageInfo,
  createId: CreateMessageId,
  now: Now = Date.now,
): Message | null {
  if (m.role === "tool") return null;
  const role = m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant";
  const mediaFiles = (m.media ?? []).map((path) => ({
    filename: displayFilenameFromPath(path),
    path,
    caption: "",
  }));
  const parsedLegacy = parseLegacyFileDeliveries(m.content);
  const files = mergeMessageFiles(parsedLegacy.files, mediaFiles);
  const text = parsedLegacy.text;
  if (!text.trim() && files.length === 0) return null;
  // Skip task completion status messages (e.g. "✓ fm_tts completed (file.mp3)")
  // — the file is already delivered via the media field on a separate message.
  if (role === "assistant" && files.length === 0 && TASK_COMPLETION_RE.test(text.trim())) {
    return null;
  }

  const toolCalls: ToolCallInfo[] =
    m.tool_calls?.filter((tc) => tc.name).map((tc) => ({
      id: tc.id || "",
      name: tc.name || "",
      status: "complete" as const,
    })) ?? [];

  return withRuntime({
    id: createId(),
    role,
    text,
    clientMessageId: m.client_message_id,
    responseToClientMessageId: m.response_to_client_message_id,
    files,
    toolCalls,
    status: "complete",
    timestamp: m.timestamp ? new Date(m.timestamp).getTime() : now(),
    historySeq: typeof m.seq === "number" ? m.seq : undefined,
    sourceToolCallId: m.tool_call_id,
  }, {}, now);
}

export function reduceConvertHistoryReplayMessageEvent(
  event: ConvertHistoryReplayMessageEvent,
): Message | null {
  return convertApiMessage(event.message, event.createId, event.now);
}
