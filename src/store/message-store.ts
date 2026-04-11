/**
 * Message store — session-scoped message state with React integration.
 *
 * Follows the same useSyncExternalStore pattern as file-store.ts.
 * Messages are keyed by sessionId. History is loaded from the API
 * on first access; streaming updates arrive via the WS adapter.
 */

import { useSyncExternalStore } from "react";
import { getMessages as fetchMessages } from "@/api/sessions";
import type { MessageInfo } from "@/api/types";
import { displayFilenameFromPath } from "@/lib/utils";
import { addFile as addToFileStore } from "@/store/file-store";

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
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const messagesBySession = new Map<string, Message[]>();
const listeners = new Set<() => void>();
/** Track which sessions have already loaded history from the API. */
const loadedSessions = new Set<string>();
/** Track in-flight history loads to avoid duplicate requests. */
const loadingPromises = new Map<string, Promise<void>>();

let version = 0;
// Snapshot cache keyed by sessionId — invalidated on every notify().
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

function getMessageSnapshot(sessionId: string): Message[] {
  const cached = messageSnapshots.get(sessionId);
  if (cached && cached.version === version) return cached.data;
  const data = messagesBySession.get(sessionId) ?? [];
  messageSnapshots.set(sessionId, { version, data });
  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;

function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

function getList(sessionId: string): Message[] {
  let list = messagesBySession.get(sessionId);
  if (!list) {
    list = [];
    messagesBySession.set(sessionId, list);
  }
  return list;
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
  return text.replace(/\s+/gu, " ").trim();
}

function sameFilePaths(a: MessageFile[], b: MessageFile[]): boolean {
  if (a.length !== b.length) return false;
  const aPaths = [...a.map((file) => file.path)].sort();
  const bPaths = [...b.map((file) => file.path)].sort();
  return aPaths.every((path, index) => path === bPaths[index]);
}

function sameToolCallNames(a: ToolCallInfo[], b: ToolCallInfo[]): boolean {
  if (a.length !== b.length) return false;
  const aNames = [...a.map((tool) => tool.name)].sort();
  const bNames = [...b.map((tool) => tool.name)].sort();
  return aNames.every((name, index) => name === bNames[index]);
}

function findOptimisticMatchIndex(list: Message[], authoritative: Message): number {
  if (authoritative.clientMessageId) {
    const directMatchIndex = list.findIndex(
      (candidate) =>
        candidate.role === authoritative.role &&
        candidate.clientMessageId === authoritative.clientMessageId,
    );
    if (directMatchIndex !== -1) return directMatchIndex;
  }

  if (authoritative.responseToClientMessageId) {
    const responseMatchIndex = list.findIndex(
      (candidate) =>
        candidate.role === authoritative.role &&
        candidate.responseToClientMessageId === authoritative.responseToClientMessageId,
    );
    if (responseMatchIndex !== -1) return responseMatchIndex;
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
    if (!sameFilePaths(candidate.files, authoritative.files)) continue;
    if (!sameToolCallNames(candidate.toolCalls, authoritative.toolCalls)) continue;

    const timeDelta = Math.abs(candidate.timestamp - authoritativeTime);
    if (timeDelta > 60_000) continue;
    if (timeDelta >= bestTimeDelta) continue;

    bestIndex = index;
    bestTimeDelta = timeDelta;
  }

  return bestIndex;
}

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

function replaceHistoryFromApi(sessionId: string, apiMessages: MessageInfo[]): void {
  const converted = apiMessages
    .map(convertApiMessage)
    .filter((message): message is Message => message !== null);
  messagesBySession.set(sessionId, converted);
  indexFilesForSession(sessionId, converted);
  loadedSessions.add(sessionId);
  notify();
}

// ---------------------------------------------------------------------------
// Public API — mutators
// ---------------------------------------------------------------------------

/** Add a new message and return its id. */
export function addMessage(
  sessionId: string,
  msg: Omit<Message, "id" | "timestamp">,
): string {
  const id = nextId();
  const list = getList(sessionId);
  list.push({ ...msg, id, timestamp: Date.now() });
  // Replace the array reference so React picks up the change
  messagesBySession.set(sessionId, [...list]);
  notify();
  return id;
}

/** Update fields on an existing message. */
export function updateMessage(
  sessionId: string,
  messageId: string,
  updates: Partial<Pick<Message, "text" | "status" | "files" | "toolCalls">>,
): void {
  const list = messagesBySession.get(sessionId);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], ...updates };
  messagesBySession.set(sessionId, [...list]);
  notify();
}

/** Append text to a streaming message. */
export function appendText(
  sessionId: string,
  messageId: string,
  chunk: string,
): void {
  const list = messagesBySession.get(sessionId);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  list[idx] = { ...list[idx], text: list[idx].text + chunk };
  messagesBySession.set(sessionId, [...list]);
  notify();
}

/** Append a file to a message, de-duplicating by path. */
export function appendFile(
  sessionId: string,
  messageId: string,
  file: MessageFile,
): void {
  const list = messagesBySession.get(sessionId);
  if (!list) return;
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  const msg = list[idx];
  if (msg.files.some((f) => f.path === file.path)) return;
  list[idx] = { ...msg, files: [...msg.files, file] };
  messagesBySession.set(sessionId, [...list]);
  addToFileStore({
    sessionId,
    filename: file.filename,
    filePath: file.path,
    caption: file.caption ?? "",
  });
  notify();
}

/** Get messages for a session (snapshot, not reactive). */
export function getMessages(sessionId: string): Message[] {
  return messagesBySession.get(sessionId) ?? [];
}

/** Clear all messages for a session (e.g. on session delete). */
export function clearMessages(sessionId: string): void {
  messagesBySession.delete(sessionId);
  loadedSessions.delete(sessionId);
  loadingPromises.delete(sessionId);
  notify();
}

export function getMaxHistorySeq(sessionId: string): number {
  return getMessages(sessionId).reduce((maxSeq, message) => {
    if (typeof message.historySeq !== "number") return maxSeq;
    return Math.max(maxSeq, message.historySeq);
  }, -1);
}

export function replaceHistory(sessionId: string, apiMessages: MessageInfo[]): void {
  replaceHistoryFromApi(sessionId, apiMessages);
}

export function appendHistoryMessages(sessionId: string, apiMessages: MessageInfo[]): number {
  if (apiMessages.length === 0) return getMaxHistorySeq(sessionId);

  const list = getList(sessionId);
  let changed = false;
  let maxSeq = getMaxHistorySeq(sessionId);

  for (const apiMessage of apiMessages) {
    const converted = convertApiMessage(apiMessage);
    if (!converted) continue;
    if (
      typeof converted.historySeq === "number" &&
      list.some((message) => message.historySeq === converted.historySeq)
    ) {
      maxSeq = Math.max(maxSeq, converted.historySeq);
      continue;
    }

    const optimisticMatchIndex = findOptimisticMatchIndex(list, converted);
    if (optimisticMatchIndex !== -1) {
      const optimistic = list[optimisticMatchIndex];
      list[optimisticMatchIndex] = {
        ...optimistic,
        text: converted.text,
        clientMessageId: converted.clientMessageId ?? optimistic.clientMessageId,
        responseToClientMessageId:
          converted.responseToClientMessageId ?? optimistic.responseToClientMessageId,
        files: mergeMessageFiles(converted.files, optimistic.files),
        toolCalls: converted.toolCalls.length > 0 ? converted.toolCalls : optimistic.toolCalls,
        status: "complete",
        timestamp: converted.timestamp,
        historySeq: converted.historySeq,
      };
      if (typeof converted.historySeq === "number") {
        maxSeq = Math.max(maxSeq, converted.historySeq);
      }
      changed = true;
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
    messagesBySession.set(sessionId, [...list]);
    indexFilesForSession(sessionId, list);
    loadedSessions.add(sessionId);
    notify();
  }

  return maxSeq;
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
): string {
  const list = getList(sessionId);
  const existing = [...list]
    .reverse()
    .find((message) => message.role === "assistant" && message.status === "streaming");

  if (existing) {
    if (!existing.text && text) {
      existing.text = text;
      messagesBySession.set(sessionId, [...list]);
      notify();
    }
    return existing.id;
  }

  const latestAssistantText = [...list]
    .reverse()
    .find((message) => message.role === "assistant" && message.text.trim())
    ?.text;
  const initialText = latestAssistantText || text;

  const id = nextId();
  list.push({
    id,
    role: "assistant",
    text: initialText,
    files: [],
    toolCalls: [],
    status: "streaming",
    timestamp: Date.now(),
  });
  messagesBySession.set(sessionId, [...list]);
  notify();
  return id;
}

// ---------------------------------------------------------------------------
// History loading
// ---------------------------------------------------------------------------

/**
 * Load message history from the API for a session.
 * No-ops if already loaded. Safe to call multiple times concurrently.
 */
export function loadHistory(sessionId: string): Promise<void> {
  if (loadedSessions.has(sessionId)) return Promise.resolve();

  const existing = loadingPromises.get(sessionId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const apiMessages = await fetchMessages(sessionId);
      // Only populate if the store is still empty for this session
      // (streaming may have started while we were loading)
      if (!messagesBySession.has(sessionId) || messagesBySession.get(sessionId)!.length === 0) {
        replaceHistoryFromApi(sessionId, apiMessages);
      }
    } catch {
      // API unavailable — not fatal, store stays empty
    } finally {
      loadingPromises.delete(sessionId);
    }
  })();

  loadingPromises.set(sessionId, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/** Subscribe to messages for a specific session. */
export function useMessages(sessionId: string): Message[] {
  return useSyncExternalStore(
    subscribe,
    () => getMessageSnapshot(sessionId),
    () => getMessageSnapshot(sessionId),
  );
}
