import type { MessageInfo } from "../../api/types";
import type { Message, ToolCallInfo } from "../message-store";
import { displayFilenameFromPath } from "../../lib/utils";
import type { CreateMessageId, Now } from "./shared";
import {
  mergeMessageFiles,
  normalizeMessageText,
  sortedMessagesForDisplay,
  TASK_COMPLETION_RE,
  withRuntime,
} from "./shared";
import {
  findFileResultTargetIndex,
  mergeFileResultIntoTarget,
  parseLegacyFileDeliveries,
} from "./file-artifact-reducer";

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

/**
 * Dedup layer for history messages that arrive without a `seq`.
 *
 * Both `appendHistoryMessages` seq-guard and the confirmed-text-dupe check
 * require `typeof historySeq === "number"`. Legacy replay paths and some skill
 * events emit `MessageInfo` without `seq`, so they bypass both guards and
 * re-append on every poll (the "已记住 ..." reappear bug). This helper catches
 * that case by matching same role + normalized text + timestamp within a
 * short window.
 */
const NO_SEQ_DUP_WINDOW_MS = 10_000;

export function findNoSeqDuplicateIndex(list: Message[], converted: Message): number {
  if (typeof converted.historySeq === "number") return -1;
  const textKey = normalizeMessageText(converted.text);
  if (!textKey) return -1;
  return list.findIndex(
    (existing) =>
      existing.kind !== "task_anchor" &&
      existing.role === converted.role &&
      normalizeMessageText(existing.text) === textKey &&
      Math.abs(existing.timestamp - converted.timestamp) < NO_SEQ_DUP_WINDOW_MS,
  );
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

      // Streaming-bubble fast path is gated on positive cmid correlation.
      // Without this gate, a concurrent background-task `session_result` (no
      // cmid) would clobber the live streaming bubble's text with an older
      // snapshot and flip status to "complete" mid-stream, producing the
      // visible UI flicker users reported.
      const candidateCmid =
        candidate.responseToClientMessageId ?? candidate.clientMessageId;
      const authoritativeCmid =
        authoritative.responseToClientMessageId ?? authoritative.clientMessageId;
      if (
        candidateCmid &&
        authoritativeCmid &&
        candidateCmid === authoritativeCmid
      ) {
        return index;
      }
      // Without cmid correlation, fall through to the text-similarity match
      // below — that still handles recovery-replay where the resumed bubble's
      // text matches the committed answer.
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

// ---------------------------------------------------------------------------
// Full three-phase history replacement projector
// ---------------------------------------------------------------------------

export interface ReplaceHistoryEvent {
  type: "replace_history_from_api";
  existing: Message[];
  apiMessages: MessageInfo[];
  outputPathMessageIds?: ReadonlyMap<string, string>;
  createId: CreateMessageId;
  now?: Now;
}

export interface ReplaceHistoryProjection {
  messages: Message[];
}

const PENDING_USER_RETAIN_MS = 120_000;
const PENDING_ASSISTANT_RETAIN_MS = 30_000;

/**
 * Pure projector for replaceHistory. Returns the fully merged + sorted list
 * without mutating any caller state. The three phases are:
 *
 *   Phase 1  Convert API messages to local form; merge with optimistic
 *            matches to preserve local-only state (id, meta, files from SSE).
 *   Phase 2  Collect unconsumed optimistic messages — drop stale completed
 *            ones that should have matched but didn't; keep streaming
 *            messages unconditionally; keep recent optimistic messages.
 *   Phase 3  Merge authoritative + pending, coalesce late file results into
 *            their anchor bubbles, then sort for display.
 */
export function reduceReplaceHistoryEvent(
  event: ReplaceHistoryEvent,
): ReplaceHistoryProjection {
  const { existing, apiMessages, outputPathMessageIds, createId } = event;
  const now = event.now ?? Date.now;
  const consumedOptimisticIndices = new Set<number>();

  // Phase 1
  const authoritative: Message[] = [];
  for (const apiMessage of apiMessages) {
    const converted = convertApiMessage(apiMessage, createId, now);
    if (!converted) continue;
    const optimisticMatchIndex = findOptimisticMatchIndex(existing, converted);
    if (
      optimisticMatchIndex === -1 ||
      consumedOptimisticIndices.has(optimisticMatchIndex)
    ) {
      authoritative.push(converted);
      continue;
    }
    consumedOptimisticIndices.add(optimisticMatchIndex);
    authoritative.push(
      mergeAuthoritativeIntoMessage(existing[optimisticMatchIndex], converted, now),
    );
  }

  // Phase 2
  const currentTimestamp = now();
  const pending: Message[] = [];
  for (let i = 0; i < existing.length; i += 1) {
    if (consumedOptimisticIndices.has(i)) continue;
    const msg = existing[i];
    if (typeof msg.historySeq === "number") continue;
    if (msg.kind === "task_anchor") {
      pending.push(msg);
      continue;
    }
    if (msg.status === "streaming" || msg.status === "error" || msg.status === "stopped") {
      pending.push(msg);
      continue;
    }
    if (msg.role === "user") {
      if (currentTimestamp - msg.timestamp < PENDING_USER_RETAIN_MS) {
        pending.push(msg);
      }
      continue;
    }
    if (msg.files.length > 0 || msg.text.trim().length > 0) {
      if (currentTimestamp - msg.timestamp < PENDING_ASSISTANT_RETAIN_MS) {
        pending.push(msg);
      }
    }
  }

  // Phase 3
  const coalesced: Message[] = [];
  for (const message of authoritative) {
    const targetIndex = findFileResultTargetIndex(
      outputPathMessageIds,
      coalesced,
      message,
    );
    if (targetIndex === -1) {
      coalesced.push(message);
      continue;
    }
    coalesced[targetIndex] = mergeFileResultIntoTarget(coalesced[targetIndex], message);
  }

  return {
    messages: sortedMessagesForDisplay([...coalesced, ...pending]),
  };
}
