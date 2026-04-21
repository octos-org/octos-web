/**
 * Message store — session/topic-scoped message state with React integration.
 *
 * Follows the same useSyncExternalStore pattern as file-store.ts.
 * Messages are keyed by sessionId plus optional history topic. History is
 * loaded from the API on first access; streaming updates arrive via the
 * runtime bridges.
 */

import { useSyncExternalStore } from "react";
import { getMessages as fetchMessages } from "@/api/sessions";
import type { MessageInfo } from "@/api/types";
import { displayFilenameFromPath } from "@/lib/utils";
import { addFile as addToFileStore } from "@/store/file-store";
import { recordRuntimeCounter } from "@/runtime/observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallInfo {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
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

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  clientMessageId?: string;
  responseToClientMessageId?: string;
  files: MessageFile[];
  toolCalls: ToolCallInfo[];
  status: "streaming" | "complete" | "error";
  timestamp: number;
  historySeq?: number;
  meta?: MessageMeta;
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

function parseLegacyFileLine(line: string): MessageFile | null {
  const match = line.trim().match(/^\[file:([^\]]+)\]\s*(.*)$/u);
  if (!match) return null;

  const path = match[1]?.trim();
  if (!path) return null;

  const fallbackName = displayFilenameFromPath(path);
  const remainder = (match[2] || "").trim();
  if (!remainder) {
    return { filename: fallbackName, path, caption: "" };
  }

  const separator = " — ";
  const sepIdx = remainder.indexOf(separator);
  if (sepIdx === -1) {
    return { filename: remainder || fallbackName, path, caption: "" };
  }

  const filename = remainder.slice(0, sepIdx).trim() || fallbackName;
  const caption = remainder.slice(sepIdx + separator.length).trim();
  return { filename, path, caption };
}

function parseLegacyFileDeliveries(content: string): {
  text: string;
  files: MessageFile[];
} {
  if (!content.includes("[file:")) {
    return { text: content, files: [] };
  }

  const files: MessageFile[] = [];
  const remainingLines: string[] = [];
  const seenPaths = new Set<string>();

  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseLegacyFileLine(line);
    if (!parsed) {
      remainingLines.push(line);
      continue;
    }

    if (seenPaths.has(parsed.path)) continue;
    seenPaths.add(parsed.path);
    files.push(parsed);
  }

  return {
    text: remainingLines.join("\n").trim(),
    files,
  };
}

function mergeMessageFiles(primary: MessageFile[], fallback: MessageFile[]): MessageFile[] {
  const merged = new Map<string, MessageFile>();

  for (const file of primary) {
    merged.set(file.path, file);
  }

  for (const file of fallback) {
    const existing = merged.get(file.path);
    if (!existing) {
      merged.set(file.path, file);
      continue;
    }

    merged.set(file.path, {
      ...existing,
      filename: existing.filename || file.filename,
      caption: existing.caption || file.caption || "",
    });
  }

  return Array.from(merged.values());
}

function normalizeMessageText(text: string): string {
  // Strip tool progress lines, streaming stats, and provider info that
  // may differ between the SSE-streamed text and the API-stored text.
  const lines = text.split("\n").filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^[✓✗⚙📄✦]\s*[`[]/u.test(t)) return false; // tool badges
    if (/^via\s+\S+\s+\(/u.test(t)) return false; // provider info
    if (/^\d+s(\s*·\s*[\d.]+k?[↑↓].*)?$/u.test(t)) return false; // streaming stats
    if (t === "Processing") return false;
    return true;
  });
  return lines.join(" ").replace(/\s+/gu, " ").trim();
}

function shouldCollapseAuthoritativeDuplicate(
  candidate: Message,
  authoritative: Message,
): boolean {
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

function findOptimisticMatchIndex(list: Message[], authoritative: Message): number {
  if (authoritative.clientMessageId) {
    const directMatchIndex = list.findIndex(
      (candidate) =>
        typeof candidate.historySeq !== "number" &&
        candidate.role === authoritative.role &&
        candidate.clientMessageId === authoritative.clientMessageId,
    );
    if (directMatchIndex !== -1) return directMatchIndex;
  }

  if (authoritative.responseToClientMessageId) {
    const responseMatchIndex = list.findIndex(
      (candidate) =>
        typeof candidate.historySeq !== "number" &&
        candidate.role === authoritative.role &&
        candidate.responseToClientMessageId === authoritative.responseToClientMessageId,
    );
    if (responseMatchIndex !== -1) return responseMatchIndex;
  }

  if (authoritative.role === "assistant") {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const candidate = list[index];
      if (typeof candidate.historySeq === "number") continue;
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

function mergeAuthoritativeIntoMessage(
  existing: Message,
  authoritative: Message,
): Message {
  return {
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
  };
}

/** Task completion notifications are status messages, not real responses. */
const TASK_COMPLETION_RE = /^[✓✗]\s+\S+\s+(completed|failed)\s*\(/u;

function convertApiMessage(m: MessageInfo): Message | null {
  if (m.role === "tool") return null;
  const role = m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant";
  const mediaFiles: MessageFile[] = (m.media ?? []).map((path) => ({
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

  return {
    id: nextId(),
    role,
    text,
    clientMessageId: m.client_message_id,
    responseToClientMessageId: m.response_to_client_message_id,
    files,
    toolCalls,
    status: "complete",
    timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
    historySeq: typeof m.seq === "number" ? m.seq : undefined,
  };
}

function indexFilesForSession(sessionId: string, messages: Message[]): void {
  for (const message of messages) {
    for (const file of message.files) {
      addToFileStore({
        sessionId,
        filename: file.filename,
        filePath: file.path,
        caption: file.caption ?? "",
      });
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
  const consumedOptimisticIndices = new Set<number>();

  // Phase 1: Convert API messages to local format, merging with optimistic
  // matches to preserve local-only state (id, meta, files from SSE).
  const authoritative = apiMessages
    .map(convertApiMessage)
    .filter((message): message is Message => message !== null)
    .map((message) => {
      const optimisticMatchIndex = findOptimisticMatchIndex(existing, message);
      if (
        optimisticMatchIndex === -1 ||
        consumedOptimisticIndices.has(optimisticMatchIndex)
      ) {
        return message;
      }

      consumedOptimisticIndices.add(optimisticMatchIndex);
      const optimistic = existing[optimisticMatchIndex];
      return mergeAuthoritativeIntoMessage(optimistic, message);
    });

  // Phase 2: Collect unconsumed optimistic messages — these are local-only
  // messages the server hasn't seen yet (user just typed, or still streaming).
  // Drop stale completed messages that SHOULD have matched but didn't (e.g.
  // the server returned a slightly different text after tool-progress cleanup).
  // Keep streaming messages unconditionally — they're actively being built.
  const pending: Message[] = [];
  for (let i = 0; i < existing.length; i++) {
    if (consumedOptimisticIndices.has(i)) continue;
    const msg = existing[i];
    // Already confirmed by server in a prior sync — server is authoritative.
    if (typeof msg.historySeq === "number") continue;
    // Streaming or has local-only content — keep it.
    if (msg.status === "streaming" || msg.status === "error") {
      pending.push(msg);
      continue;
    }
    // Completed optimistic user message not yet in API — keep if recent.
    if (msg.role === "user") {
      const age = Date.now() - msg.timestamp;
      if (age < 120_000) {
        pending.push(msg);
      }
      continue;
    }
    // Completed assistant message not matched — keep only if it has
    // meaningful content (files or text) that may not be in API yet.
    if (msg.files.length > 0 || msg.text.trim().length > 0) {
      const age = Date.now() - msg.timestamp;
      if (age < 30_000) {
        pending.push(msg);
      }
    }
  }

  // Phase 3: Merge and sort — authoritative first by seq, pending at the end
  // ordered by timestamp.
  const merged = [...authoritative, ...pending];
  merged.sort((a, b) => {
    const aSeq = typeof a.historySeq === "number" ? a.historySeq : Number.MAX_SAFE_INTEGER;
    const bSeq = typeof b.historySeq === "number" ? b.historySeq : Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) return aSeq - bSeq;
    return a.timestamp - b.timestamp;
  });

  messagesByKey.set(key, merged);
  indexFilesForSession(sessionId, merged);
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
  list.push({ ...msg, id, timestamp: Date.now() });
  // Replace the array reference so React picks up the change
  messagesByKey.set(key, [...list]);
  notify();
  return id;
}

/** Update fields on an existing message. */
export function updateMessage(
  sessionId: string,
  messageId: string,
  updates: Partial<Pick<Message, "text" | "status" | "files" | "toolCalls" | "meta">>,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...updates };
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
  list[idx] = { ...list[idx], text: list[idx].text + chunk };
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
  list[idx] = { ...msg, files: [...msg.files, file] };
  messagesByKey.set(key, [...list]);
  addToFileStore({
    sessionId,
    filename: file.filename,
    filePath: file.path,
    caption: file.caption ?? "",
  });
  notify();
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
  } else {
    for (const messageKey of [...messagesByKey.keys()]) {
      if (messageKey === sessionId || messageKey.startsWith(`${sessionId}#`)) {
        messagesByKey.delete(messageKey);
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
    const converted = convertApiMessage(apiMessage);
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

    // Safety: check if a confirmed message with the same text+role already
    // exists (e.g. two turns produced identical responses and the optimistic
    // matcher consumed the wrong one). Merge into the existing message rather
    // than adding a duplicate.
    const confirmedDupe = list.findIndex(
      (m) =>
        typeof m.historySeq === "number" &&
        m.role === converted.role &&
        m.files.length === 0 &&
        converted.files.length === 0 &&
        normalizeMessageText(m.text) === normalizeMessageText(converted.text) &&
        typeof converted.historySeq === "number" &&
        m.historySeq !== converted.historySeq &&
        Math.abs(m.timestamp - converted.timestamp) < 120_000,
    );
    if (confirmedDupe !== -1) {
      // Already have a confirmed message with same content — this is likely
      // the correct instance. Skip adding a duplicate; the existing one is
      // close enough (authoritative seq may differ but UI position is right).
      recordRuntimeCounter("octos_result_duplicate_suppressed_total", {
        kind: converted.role,
        reason: "confirmed_text_match",
      });
      if (typeof converted.historySeq === "number") {
        maxSeq = Math.max(maxSeq, converted.historySeq);
      }
      continue;
    }

    list.push(converted);
    if (typeof converted.historySeq === "number") {
      maxSeq = Math.max(maxSeq, converted.historySeq);
    }
    changed = true;
  }

  if (changed) {
    list.sort((a, b) => {
      const aSeq = typeof a.historySeq === "number" ? a.historySeq : Number.MAX_SAFE_INTEGER;
      const bSeq = typeof b.historySeq === "number" ? b.historySeq : Number.MAX_SAFE_INTEGER;
      if (aSeq !== bSeq) return aSeq - bSeq;
      return a.timestamp - b.timestamp;
    });
    messagesByKey.set(key, [...list]);
    indexFilesForSession(sessionId, list);
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
  const converted = convertApiMessage(apiMessage);
  if (!converted) return false;

  const key = storeKey(sessionId, topic);
  const list = messagesByKey.get(key);
  if (!list) return false;

  let targetIndex = list.findIndex((message) => message.id === messageId);
  if (targetIndex === -1) return false;

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

  list.sort((a, b) => {
    const aSeq = typeof a.historySeq === "number" ? a.historySeq : Number.MAX_SAFE_INTEGER;
    const bSeq = typeof b.historySeq === "number" ? b.historySeq : Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) return aSeq - bSeq;
    return a.timestamp - b.timestamp;
  });

  messagesByKey.set(key, [...list]);
  indexFilesForSession(sessionId, list);
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
  const existing = [...list]
    .reverse()
    .find((message) => message.role === "assistant" && message.status === "streaming");

  if (existing) {
    if (!existing.text && text) {
      existing.text = text;
      messagesByKey.set(key, [...list]);
      notify();
    }
    return existing.id;
  }

  const id = nextId();
  list.push({
    id,
    role: "assistant",
    text,
    files: [],
    toolCalls: [],
    status: "streaming",
    timestamp: Date.now(),
  });
  messagesByKey.set(key, [...list]);
  notify();
  return id;
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

    next.push({
      ...message,
      text:
        !options?.streamActive && isResumePlaceholderText(message.text)
          ? ""
          : message.text,
      status: "complete",
    });
    changed = true;
    recordRuntimeCounter("octos_recovery_stream_cleanup_total", {
      action: "finalize_orphan",
    });
  }

  if (!changed) return;

  messagesByKey.set(key, next);
  notify();
}

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
