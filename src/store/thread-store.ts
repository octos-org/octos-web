/**
 * Thread store — thread-by-cmid chat data model (M8.10, issue #627).
 *
 * Every user message roots a `Thread` keyed by its `client_message_id`.
 * Assistant and tool messages bind to the thread via
 * `response_to_client_message_id` (= `thread_id` from PR #2's SSE events).
 * Conversations are an ordered list of threads sorted by
 * `userMsg.timestamp` — within a thread, responses sort strictly by
 * `intra_thread_seq` (the server-side per-thread sequence).
 *
 * After M8.10 PR #5, this is THE chat data model. The legacy flat-list
 * `message-store.ts`, the localStorage feature flag, and the
 * dual-rendering switch in `chat-thread.tsx` are gone.
 */

import { useSyncExternalStore } from "react";
import { getMessages as fetchMessages } from "@/api/sessions";
import type { BackgroundTaskInfo, MessageInfo } from "@/api/types";
import { displayFilenameFromPath } from "@/lib/utils";
import { addFile as addToFileStore } from "@/store/file-store";
import { recordRuntimeCounter } from "@/runtime/observability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadProgressEntry {
  message: string;
  ts: number;
}

export interface ThreadToolCall {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  progress: ThreadProgressEntry[];
  /** 0 for first call, 1 for first retry, etc. Tool retries with the same name
   *  collapse into one tool call entry rather than rendering N duplicate pills. */
  retryCount: number;
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

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  files: MessageFile[];
  toolCalls: ThreadToolCall[];
  status: "streaming" | "complete" | "error";
  timestamp: number;
  /** Server-side per-session sequence (assigned on persistence). */
  historySeq?: number;
  /** Per-thread sequence — order within a thread. */
  intra_thread_seq?: number;
  meta?: MessageMeta;
  /** For assistant/tool messages: parent thread root cmid. */
  responseToClientMessageId?: string;
  /** For user messages: their own cmid (= thread.id). */
  clientMessageId?: string;
  /** For tool result messages: the originating tool_call_id. */
  sourceToolCallId?: string;
}

export interface Thread {
  /** = `client_message_id` of the user message that rooted this thread. */
  id: string;
  userMsg: ThreadMessage;
  /** Assistant + tool messages bound to this thread, ordered by
   *  intra_thread_seq (server-authoritative) with arrival-order fallback. */
  responses: ThreadMessage[];
  /** In-flight assistant message for the current turn (becomes part of
   *  `responses` when `finalizeAssistant` is called). */
  pendingAssistant: ThreadMessage | null;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface SessionState {
  /** Threads in user-message-timestamp order (stable). */
  threads: Thread[];
  /** Index from thread id (= user cmid) → thread for O(1) routing. */
  byId: Map<string, Thread>;
}

const sessionsByKey = new Map<string, SessionState>();
const listeners = new Set<() => void>();
const loadedSessions = new Set<string>();
const loadingPromises = new Map<string, Promise<void>>();

let version = 0;
const snapshotCache = new Map<string, { version: number; data: Thread[] }>();

function notify() {
  version++;
  snapshotCache.clear();
  for (const fn of listeners) fn();
}

function storeKey(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
}

function ensureSession(key: string): SessionState {
  let state = sessionsByKey.get(key);
  if (!state) {
    state = { threads: [], byId: new Map() };
    sessionsByKey.set(key, state);
  }
  return state;
}

let idCounter = 0;
function nextId(): string {
  return `tm-${Date.now()}-${++idCounter}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Synthesize a thread_id when the server omits it (legacy daemon, edge
 *  case). Falls back to the most-recent thread that has a pending
 *  assistant. Returns null when no such thread exists — in that case the
 *  caller should drop the event and bump the missing-thread counter. */
function synthesizeThreadIdForOrphan(state: SessionState): string | null {
  for (let i = state.threads.length - 1; i >= 0; i -= 1) {
    if (state.threads[i].pendingAssistant) return state.threads[i].id;
  }
  return null;
}

function makeUserMessage(opts: {
  text: string;
  clientMessageId: string;
  files: MessageFile[];
  timestamp?: number;
}): ThreadMessage {
  return {
    id: nextId(),
    role: "user",
    text: opts.text,
    files: opts.files,
    toolCalls: [],
    status: "complete",
    timestamp: opts.timestamp ?? Date.now(),
    clientMessageId: opts.clientMessageId,
  };
}

function makeAssistantPlaceholder(threadId: string): ThreadMessage {
  return {
    id: nextId(),
    role: "assistant",
    text: "",
    files: [],
    toolCalls: [],
    status: "streaming",
    timestamp: Date.now(),
    responseToClientMessageId: threadId,
  };
}

function insertThreadInTimestampOrder(state: SessionState, thread: Thread): void {
  const threads = state.threads;
  // Insertion sort by user-msg timestamp, stable for equal timestamps.
  let i = threads.length - 1;
  while (i >= 0 && threads[i].userMsg.timestamp > thread.userMsg.timestamp) i -= 1;
  threads.splice(i + 1, 0, thread);
  state.byId.set(thread.id, thread);
}

function sortResponsesInThread(thread: Thread): void {
  thread.responses.sort((a, b) => {
    const as =
      typeof a.intra_thread_seq === "number"
        ? a.intra_thread_seq
        : typeof a.historySeq === "number"
          ? a.historySeq
          : Number.NaN;
    const bs =
      typeof b.intra_thread_seq === "number"
        ? b.intra_thread_seq
        : typeof b.historySeq === "number"
          ? b.historySeq
          : Number.NaN;
    // If both have a sequence, sort by it strictly.
    if (!Number.isNaN(as) && !Number.isNaN(bs)) return as - bs;
    // Otherwise fall back to arrival timestamp (tie-broken by id for stability).
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------
// Public API — mutators
// ---------------------------------------------------------------------------

export interface AddUserMessageOptions {
  text: string;
  clientMessageId: string;
  files?: MessageFile[];
  topic?: string;
}

export function addUserMessage(
  sessionId: string,
  opts: AddUserMessageOptions,
): { threadId: string; pendingAssistantId: string } {
  const key = storeKey(sessionId, opts.topic);
  const state = ensureSession(key);

  const userMsg = makeUserMessage({
    text: opts.text,
    clientMessageId: opts.clientMessageId,
    files: opts.files ?? [],
  });
  const pendingAssistant = makeAssistantPlaceholder(opts.clientMessageId);

  // If a thread already exists with this id (e.g. the user already typed and
  // it was hydrated from history), don't double-insert. Replace the pending
  // assistant so the new turn has a fresh in-flight bubble.
  const existing = state.byId.get(opts.clientMessageId);
  if (existing) {
    existing.userMsg = userMsg;
    existing.pendingAssistant = pendingAssistant;
    notify();
    return {
      threadId: opts.clientMessageId,
      pendingAssistantId: pendingAssistant.id,
    };
  }

  const thread: Thread = {
    id: opts.clientMessageId,
    userMsg,
    responses: [],
    pendingAssistant,
  };
  insertThreadInTimestampOrder(state, thread);
  notify();
  return {
    threadId: thread.id,
    pendingAssistantId: pendingAssistant.id,
  };
}

export function appendAssistantToken(threadId: string, token: string): void {
  for (const state of sessionsByKey.values()) {
    const thread = state.byId.get(threadId);
    if (!thread || !thread.pendingAssistant) continue;
    thread.pendingAssistant.text += token;
    notify();
    return;
  }
}

export function replaceAssistantText(threadId: string, text: string): void {
  for (const state of sessionsByKey.values()) {
    const thread = state.byId.get(threadId);
    if (!thread || !thread.pendingAssistant) continue;
    thread.pendingAssistant.text = text;
    notify();
    return;
  }
}

/**
 * Add or update a tool call on the in-flight assistant bubble.
 *
 * Tool retries collapse: if the most recent toolCall on this thread shares
 * `name` with the incoming `tool_start` and is no longer running, increment
 * its `retryCount`. Otherwise create a new entry. Successive starts of the
 * same tool with different ids that arrive while the previous is "running"
 * also collapse — the LLM occasionally re-tries on the same call.
 */
export function addToolCall(
  threadId: string,
  toolCallId: string,
  name: string,
): void {
  for (const state of sessionsByKey.values()) {
    const thread = state.byId.get(threadId);
    if (!thread || !thread.pendingAssistant) continue;

    const tcs = thread.pendingAssistant.toolCalls;
    // Already known by id → idempotent (re-issued tool_start, replay).
    const byId = tcs.findIndex((tc) => tc.id === toolCallId);
    if (byId !== -1) {
      tcs[byId] = { ...tcs[byId], status: "running" };
      notify();
      return;
    }

    // Collapse retry: most recent call has same name → bump retryCount.
    const last = tcs[tcs.length - 1];
    if (last && last.name === name) {
      tcs[tcs.length - 1] = {
        ...last,
        id: toolCallId,
        status: "running",
        retryCount: last.retryCount + 1,
        // Carry forward progress so the user keeps the running narration.
        progress: last.progress,
      };
      notify();
      return;
    }

    tcs.push({
      id: toolCallId,
      name,
      status: "running",
      progress: [],
      retryCount: 0,
    });
    notify();
    return;
  }
}

export function appendToolProgress(
  threadId: string,
  toolCallId: string,
  message: string,
): void {
  for (const state of sessionsByKey.values()) {
    const thread = state.byId.get(threadId);
    if (!thread || !thread.pendingAssistant) continue;

    const tcs = thread.pendingAssistant.toolCalls;
    let target = tcs.find((tc) => tc.id === toolCallId);
    if (!target) {
      // Late-arriving progress for a tool whose start we missed (e.g. SSE
      // resumed mid-stream). Create a stub call so the progress isn't lost.
      target = {
        id: toolCallId,
        name: "",
        status: "running",
        progress: [],
        retryCount: 0,
      };
      tcs.push(target);
    }
    target.progress.push({ message, ts: Date.now() });
    notify();
    return;
  }
}

export function setToolCallStatus(
  threadId: string,
  toolCallId: string,
  status: ThreadToolCall["status"],
): void {
  for (const state of sessionsByKey.values()) {
    const thread = state.byId.get(threadId);
    if (!thread || !thread.pendingAssistant) continue;

    const tcs = thread.pendingAssistant.toolCalls;
    const idx = tcs.findIndex((tc) => tc.id === toolCallId);
    if (idx === -1) return;
    tcs[idx] = { ...tcs[idx], status };
    notify();
    return;
  }
}

/** Append a delivered file to the current pending assistant in the thread. */
export function appendAssistantFile(
  threadId: string,
  file: MessageFile,
): boolean {
  for (const state of sessionsByKey.values()) {
    const thread = state.byId.get(threadId);
    if (!thread || !thread.pendingAssistant) continue;
    if (thread.pendingAssistant.files.some((f) => f.path === file.path)) return true;
    thread.pendingAssistant.files = [
      ...thread.pendingAssistant.files,
      file,
    ];
    notify();
    return true;
  }
  return false;
}

export interface FinalizeAssistantOptions {
  /** Per-thread server sequence assigned at persistence time. */
  committedSeq?: number;
  meta?: MessageMeta;
  /** Override status (e.g. "error" on stream error, "complete" on abort with
   *  partial text). Default: "complete". */
  status?: ThreadMessage["status"];
}

/**
 * Promote the in-flight assistant bubble to a finalized response within its
 * thread. Stamps `intra_thread_seq` from `committedSeq`, attaches optional
 * meta, and clears `pendingAssistant`.
 */
export function finalizeAssistant(
  threadId: string,
  opts: FinalizeAssistantOptions = {},
): void {
  for (const state of sessionsByKey.values()) {
    const thread = state.byId.get(threadId);
    if (!thread || !thread.pendingAssistant) continue;

    const finalized: ThreadMessage = {
      ...thread.pendingAssistant,
      status: opts.status ?? "complete",
      historySeq: opts.committedSeq ?? thread.pendingAssistant.historySeq,
      intra_thread_seq:
        opts.committedSeq ?? thread.pendingAssistant.intra_thread_seq,
      meta: opts.meta ?? thread.pendingAssistant.meta,
    };
    thread.responses.push(finalized);
    sortResponsesInThread(thread);
    thread.pendingAssistant = null;
    notify();
    return;
  }
}

// ---------------------------------------------------------------------------
// History rehydration
// ---------------------------------------------------------------------------

function fileFromMediaPath(path: string): MessageFile {
  return {
    filename: displayFilenameFromPath(path),
    path,
    caption: "",
  };
}

function buildResponseFromApi(m: MessageInfo): ThreadMessage {
  const role: ThreadMessage["role"] =
    m.role === "user"
      ? "user"
      : m.role === "system"
        ? "system"
        : m.role === "tool"
          ? "tool"
          : "assistant";
  const files = (m.media ?? []).map(fileFromMediaPath);
  const toolCalls: ThreadToolCall[] =
    m.tool_calls?.filter((tc) => tc.name).map((tc) => ({
      id: tc.id || "",
      name: tc.name || "",
      status: "complete" as const,
      progress: [],
      retryCount: 0,
    })) ?? [];

  return {
    id: nextId(),
    role,
    text: m.content,
    files,
    toolCalls,
    status: "complete",
    timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
    historySeq: typeof m.seq === "number" ? m.seq : undefined,
    intra_thread_seq: typeof m.seq === "number" ? m.seq : undefined,
    responseToClientMessageId: m.response_to_client_message_id,
    clientMessageId: m.client_message_id,
    sourceToolCallId: m.tool_call_id,
  };
}

/** Pick a thread_id for a legacy API record without one. Mirrors the
 *  server-side synthesizer in PR #1: walk the record stream, switch the
 *  current thread on every user-message role-flip, inheriting forward. */
export function deriveLegacyThreadId(
  m: MessageInfo,
  context: { currentThreadId: string | null },
): string {
  if (m.thread_id) {
    if (m.role === "user") {
      context.currentThreadId =
        m.client_message_id || m.thread_id || `synth-${nextId()}`;
    } else if (!context.currentThreadId) {
      context.currentThreadId = m.thread_id;
    }
    return m.thread_id;
  }

  if (m.role === "user") {
    const id = m.client_message_id || `synth-${m.seq ?? nextId()}`;
    context.currentThreadId = id;
    return id;
  }

  if (context.currentThreadId) return context.currentThreadId;

  // Orphan assistant/tool record before any user message — synthesize a
  // standalone thread keyed by sequence so the record is at least visible.
  const id = `synth-${m.seq ?? nextId()}`;
  context.currentThreadId = id;
  return id;
}

export function replayHistory(
  sessionId: string,
  apiMessages: MessageInfo[],
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  const state = { threads: [] as Thread[], byId: new Map<string, Thread>() };

  const ctx = { currentThreadId: null as string | null };
  for (const apiMessage of apiMessages) {
    if (apiMessage.role === "system") continue;
    const threadId = deriveLegacyThreadId(apiMessage, ctx);
    let thread = state.byId.get(threadId);

    if (apiMessage.role === "user") {
      const userMsg = buildResponseFromApi(apiMessage);
      userMsg.role = "user";
      userMsg.clientMessageId = apiMessage.client_message_id ?? threadId;
      if (thread) {
        thread.userMsg = userMsg;
      } else {
        thread = {
          id: threadId,
          userMsg,
          responses: [],
          pendingAssistant: null,
        };
        state.byId.set(threadId, thread);
        state.threads.push(thread);
      }
      continue;
    }

    if (!thread) {
      // Synthesize an empty user-rooted thread to host the orphan response.
      const placeholderUser: ThreadMessage = {
        id: nextId(),
        role: "user",
        text: "",
        files: [],
        toolCalls: [],
        status: "complete",
        timestamp: apiMessage.timestamp
          ? new Date(apiMessage.timestamp).getTime()
          : Date.now(),
        clientMessageId: threadId,
      };
      thread = {
        id: threadId,
        userMsg: placeholderUser,
        responses: [],
        pendingAssistant: null,
      };
      state.byId.set(threadId, thread);
      state.threads.push(thread);
    }

    thread.responses.push(buildResponseFromApi(apiMessage));
  }

  // Sort threads by user-msg timestamp; sort responses within each thread by
  // intra_thread_seq (= server seq for legacy).
  state.threads.sort((a, b) => a.userMsg.timestamp - b.userMsg.timestamp);
  for (const thread of state.threads) sortResponsesInThread(thread);

  sessionsByKey.set(key, state);
  loadedSessions.add(key);
  notify();
}

// ---------------------------------------------------------------------------
// History loading
// ---------------------------------------------------------------------------

export function loadHistory(
  sessionId: string,
  topic?: string,
): Promise<void> {
  const key = storeKey(sessionId, topic);
  if (loadedSessions.has(key)) return Promise.resolve();

  const existing = loadingPromises.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const apiMessages = await fetchMessages(sessionId, 500, 0, undefined, topic);
      replayHistory(sessionId, apiMessages, topic);
      loadedSessions.add(key);
    } catch {
      loadedSessions.delete(key);
    } finally {
      loadingPromises.delete(key);
    }
  })();

  loadingPromises.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Public API — accessors
// ---------------------------------------------------------------------------

export function getThreads(sessionId: string, topic?: string): Thread[] {
  const key = storeKey(sessionId, topic);
  const cached = snapshotCache.get(key);
  if (cached && cached.version === version) return cached.data;
  const state = sessionsByKey.get(key);
  const data = state ? state.threads.slice() : [];
  snapshotCache.set(key, { version, data });
  return data;
}

export function clearSession(sessionId: string, topic?: string): void {
  const key = storeKey(sessionId, topic);
  if (topic?.trim()) {
    sessionsByKey.delete(key);
    loadedSessions.delete(key);
    loadingPromises.delete(key);
    backgroundAnchorsByKey.delete(key);
    taskMessageByKey.delete(key);
    toolCallMessageByKey.delete(key);
    outputPathMessageByKey.delete(key);
  } else {
    for (const k of [...sessionsByKey.keys()]) {
      if (k === sessionId || k.startsWith(`${sessionId}#`)) {
        sessionsByKey.delete(k);
        loadedSessions.delete(k);
        loadingPromises.delete(k);
        backgroundAnchorsByKey.delete(k);
        taskMessageByKey.delete(k);
        toolCallMessageByKey.delete(k);
        outputPathMessageByKey.delete(k);
      }
    }
  }
  notify();
}

/** Alias for `clearSession` to match the consumer-facing API the legacy
 *  message-store exposed (so call-sites read symmetrically). */
export const clearMessages = clearSession;

/** Replace the session/topic threads with a fresh history snapshot. */
export function replaceHistory(
  sessionId: string,
  apiMessages: MessageInfo[],
  topic?: string,
): void {
  replayHistory(sessionId, apiMessages, topic);
}

export function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** React hook — subscribe to a session's threads. */
export function useThreads(sessionId: string, topic?: string): Thread[] {
  return useSyncExternalStore(
    (cb) => subscribe(cb),
    () => getThreads(sessionId, topic),
    () => getThreads(sessionId, topic),
  );
}

// ---------------------------------------------------------------------------
// Edge: synthesize routing target for events that arrive without thread_id
// ---------------------------------------------------------------------------

/**
 * Resolve the routing thread_id for an SSE event that may be missing the
 * `thread_id` field (legacy daemon, edge case). Returns null when no
 * pending thread is available — caller should drop the event and bump the
 * `octos_thread_id_missing_total` counter.
 */
export function resolveEventThreadId(
  sessionId: string,
  topic: string | undefined,
  payloadThreadId: string | undefined,
): string | null {
  if (payloadThreadId) return payloadThreadId;
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) {
    recordRuntimeCounter("octos_thread_id_missing_total", {
      surface: "sse_bridge",
    });
    return null;
  }
  const synthesized = synthesizeThreadIdForOrphan(state);
  if (!synthesized) {
    recordRuntimeCounter("octos_thread_id_missing_total", {
      surface: "sse_bridge",
    });
  }
  return synthesized;
}

/** Test-only helper: reset all in-memory state. Not exported in production. */
export function __resetForTests(): void {
  sessionsByKey.clear();
  listeners.clear();
  loadedSessions.clear();
  loadingPromises.clear();
  snapshotCache.clear();
  backgroundAnchorsByKey.clear();
  taskMessageByKey.clear();
  toolCallMessageByKey.clear();
  outputPathMessageByKey.clear();
  version = 0;
  idCounter = 0;
}

// ---------------------------------------------------------------------------
// Background-task / file routing
// ---------------------------------------------------------------------------
//
// SSE `file` events arrive after `done` (background tasks). To route them
// to the correct thread we maintain side-indices per session/topic.

interface BackgroundAnchor {
  threadId: string;
  toolNames: Set<string>;
  createdAt: number;
}

const backgroundAnchorsByKey = new Map<string, BackgroundAnchor[]>();
const taskMessageByKey = new Map<string, Map<string, string>>();
const toolCallMessageByKey = new Map<string, Map<string, string>>();
const outputPathMessageByKey = new Map<string, Map<string, string>>();

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

function pathMatchKeys(path: string): string[] {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = value?.trim();
    if (normalized) keys.add(normalized);
  };
  add(path);
  try {
    add(decodeURIComponent(path));
  } catch {
    // ignore
  }
  add(displayFilenameFromPath(path));
  return [...keys];
}

function normalizeToolName(name: string | undefined): string {
  if (!name) return "";
  return name === "Direct TTS" ? "fm_tts" : name;
}

function findThreadForToolCallId(
  state: SessionState,
  toolCallId: string,
): Thread | null {
  for (const thread of state.threads) {
    if (thread.pendingAssistant?.toolCalls.some((tc) => tc.id === toolCallId)) {
      return thread;
    }
    for (const response of thread.responses) {
      if (response.toolCalls.some((tc) => tc.id === toolCallId)) return thread;
      if (response.sourceToolCallId === toolCallId) return thread;
    }
  }
  return null;
}

function findRecentBackgroundAnchorThread(
  key: string,
  state: SessionState,
  toolName?: string,
): Thread | null {
  trimBackgroundAnchors(key);
  const anchors = backgroundAnchorsByKey.get(key);
  if (!anchors) return null;
  const normalizedToolName = normalizeToolName(toolName);
  for (let i = anchors.length - 1; i >= 0; i -= 1) {
    const anchor = anchors[i];
    if (
      normalizedToolName &&
      anchor.toolNames.size > 0 &&
      !anchor.toolNames.has(normalizedToolName)
    ) {
      continue;
    }
    const thread = state.byId.get(anchor.threadId);
    if (thread) return thread;
  }
  return null;
}

function indexFile(sessionId: string, file: MessageFile): void {
  addToFileStore({
    sessionId,
    filename: file.filename,
    filePath: file.path,
    caption: file.caption ?? "",
  });
}

function targetForAssistantMutation(thread: Thread): ThreadMessage | null {
  if (thread.pendingAssistant) return thread.pendingAssistant;
  if (thread.responses.length === 0) return null;
  // Append to the most recent assistant response (pending was finalized).
  for (let i = thread.responses.length - 1; i >= 0; i -= 1) {
    if (thread.responses[i].role === "assistant") return thread.responses[i];
  }
  return null;
}

/** Append a delivered file to the pending assistant (or last assistant
 *  response if pending was already finalized) for a given thread. */
export function appendFileToThread(
  sessionId: string,
  threadId: string,
  file: MessageFile,
  topic?: string,
): boolean {
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return false;
  const thread = state.byId.get(threadId);
  if (!thread) return false;
  const target = targetForAssistantMutation(thread);
  if (!target) return false;
  if (target.files.some((f) => f.path === file.path)) return true;
  target.files = [...target.files, file];
  indexFile(sessionId, file);
  notify();
  return true;
}

/** Append a delivered file to the message hosting the given tool_call_id. */
export function appendFileByToolCallId(
  sessionId: string,
  toolCallId: string | undefined,
  file: MessageFile,
  topic?: string,
): boolean {
  if (!toolCallId) return false;
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return false;

  const thread = findThreadForToolCallId(state, toolCallId);
  if (!thread) return false;

  const target = targetForAssistantMutation(thread);
  if (!target) return false;
  if (target.files.some((f) => f.path === file.path)) return true;
  target.files = [...target.files, file];

  for (const pathKey of pathMatchKeys(file.path)) {
    mapFor(outputPathMessageByKey, key).set(pathKey, target.id);
  }
  indexFile(sessionId, file);
  notify();
  return true;
}

/** Append a file to the most recent background-anchored thread. */
export function appendFileToBackgroundAnchor(
  sessionId: string,
  file: MessageFile,
  topic?: string,
): boolean {
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return false;

  const thread = findRecentBackgroundAnchorThread(key, state);
  if (!thread) return false;

  const target = targetForAssistantMutation(thread);
  if (!target) return false;
  if (target.files.some((f) => f.path === file.path)) return true;
  target.files = [...target.files, file];

  for (const pathKey of pathMatchKeys(file.path)) {
    mapFor(outputPathMessageByKey, key).set(pathKey, target.id);
  }
  indexFile(sessionId, file);
  notify();
  return true;
}

/** Mark a thread as a background anchor so post-`done` files can route to it. */
export function registerBackgroundAnchor(
  sessionId: string,
  threadId: string,
  topic?: string,
  toolNames: string[] = [],
): void {
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state?.byId.has(threadId)) return;

  trimBackgroundAnchors(key);
  const anchors = backgroundAnchorsByKey.get(key) ?? [];
  const existing = anchors.find((anchor) => anchor.threadId === threadId);
  const normalized = toolNames.map(normalizeToolName).filter(Boolean);

  if (existing) {
    for (const name of normalized) existing.toolNames.add(name);
    existing.createdAt = Date.now();
  } else {
    anchors.push({
      threadId,
      toolNames: new Set(normalized),
      createdAt: Date.now(),
    });
  }
  backgroundAnchorsByKey.set(key, anchors);
}

/** Bind a background task update to a thread, reusing the routing indices.
 *  Returns the bound thread id when matched, or null when no match. */
export function bindBackgroundTask(
  sessionId: string,
  task: BackgroundTaskInfo,
  topic?: string,
): string | null {
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return null;

  const taskMap = mapFor(taskMessageByKey, key);
  let thread: Thread | null = null;

  const existingThreadId = taskMap.get(task.id);
  if (existingThreadId) {
    thread = state.byId.get(existingThreadId) ?? null;
  }

  if (!thread && task.tool_call_id) {
    thread = findThreadForToolCallId(state, task.tool_call_id);
  }

  if (!thread) {
    thread = findRecentBackgroundAnchorThread(key, state, task.tool_name);
  }

  if (!thread) {
    // Fall back to the most recent thread with a pending assistant.
    for (let i = state.threads.length - 1; i >= 0; i -= 1) {
      if (state.threads[i].pendingAssistant) {
        thread = state.threads[i];
        break;
      }
    }
  }

  if (!thread) return null;

  taskMap.set(task.id, thread.id);
  if (task.tool_call_id) {
    mapFor(toolCallMessageByKey, key).set(task.tool_call_id, thread.id);
  }
  const outputMap = mapFor(outputPathMessageByKey, key);
  for (const path of task.output_files ?? []) {
    for (const pathKey of pathMatchKeys(path)) {
      outputMap.set(pathKey, thread.id);
    }
  }

  // Surface the task as a tool-call on the assistant bubble so the UI
  // shows progress/status.
  const target = targetForAssistantMutation(thread);
  if (target) {
    const taskToolCallId = task.tool_call_id || `task_${task.id}`;
    const status: ThreadToolCall["status"] =
      task.status === "failed"
        ? "error"
        : task.status === "spawned" || task.status === "running"
          ? "running"
          : "complete";
    const idx = target.toolCalls.findIndex((tc) => tc.id === taskToolCallId);
    const name = normalizeToolName(task.tool_name) || task.tool_name || "background_task";
    if (idx === -1) {
      target.toolCalls = [
        ...target.toolCalls,
        { id: taskToolCallId, name, status, progress: [], retryCount: 0 },
      ];
    } else {
      target.toolCalls = target.toolCalls.map((tc, i) =>
        i === idx ? { ...tc, status, name: tc.name || name } : tc,
      );
    }
  }
  notify();
  return thread.id;
}

// ---------------------------------------------------------------------------
// History / committed-seq accessors
// ---------------------------------------------------------------------------

/** Maximum committed `historySeq` observed across all responses in this
 *  session/topic. -1 if no committed messages yet. */
export function getMaxHistorySeq(sessionId: string, topic?: string): number {
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return -1;
  let max = -1;
  for (const thread of state.threads) {
    if (typeof thread.userMsg.historySeq === "number") {
      max = Math.max(max, thread.userMsg.historySeq);
    }
    for (const response of thread.responses) {
      if (typeof response.historySeq === "number") {
        max = Math.max(max, response.historySeq);
      }
    }
  }
  return max;
}

/** Flatten the thread tree into a chronological message list. Used by
 *  consumers (search, exporters, observability) that need a flat shape. */
export function flattenThreadsToMessages(threads: Thread[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const thread of threads) {
    out.push(thread.userMsg);
    for (const response of thread.responses) out.push(response);
    if (thread.pendingAssistant) out.push(thread.pendingAssistant);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Incremental history merging (replay loop after stream restart)
// ---------------------------------------------------------------------------

/** Append the given API messages, deduplicating against existing committed
 *  rows by `historySeq`. Returns the new max committed seq. */
export function appendHistoryMessages(
  sessionId: string,
  apiMessages: MessageInfo[],
  topic?: string,
): number {
  if (apiMessages.length === 0) return getMaxHistorySeq(sessionId, topic);
  const key = storeKey(sessionId, topic);
  const state = ensureSession(key);
  let changed = false;

  const ctx = { currentThreadId: null as string | null };
  // Seed ctx from the most recent user thread so trailing assistant rows
  // without thread_id can inherit it.
  for (let i = state.threads.length - 1; i >= 0; i -= 1) {
    if (state.threads[i].userMsg.clientMessageId) {
      ctx.currentThreadId = state.threads[i].id;
      break;
    }
  }

  const seenSeqs = new Set<number>();
  for (const thread of state.threads) {
    if (typeof thread.userMsg.historySeq === "number") {
      seenSeqs.add(thread.userMsg.historySeq);
    }
    for (const response of thread.responses) {
      if (typeof response.historySeq === "number") {
        seenSeqs.add(response.historySeq);
      }
    }
  }

  for (const apiMessage of apiMessages) {
    if (apiMessage.role === "system") continue;
    if (typeof apiMessage.seq === "number" && seenSeqs.has(apiMessage.seq)) {
      continue;
    }

    const threadId = deriveLegacyThreadId(apiMessage, ctx);
    let thread = state.byId.get(threadId);

    if (apiMessage.role === "user") {
      const userMsg = buildResponseFromApi(apiMessage);
      userMsg.role = "user";
      userMsg.clientMessageId = apiMessage.client_message_id ?? threadId;
      if (thread) {
        // Prefer the existing pending pendingAssistant. Just enrich seq.
        thread.userMsg = {
          ...thread.userMsg,
          historySeq: userMsg.historySeq ?? thread.userMsg.historySeq,
          intra_thread_seq:
            userMsg.intra_thread_seq ?? thread.userMsg.intra_thread_seq,
          clientMessageId: userMsg.clientMessageId ?? thread.userMsg.clientMessageId,
        };
      } else {
        thread = {
          id: threadId,
          userMsg,
          responses: [],
          pendingAssistant: null,
        };
        insertThreadInTimestampOrder(state, thread);
      }
      changed = true;
      continue;
    }

    if (!thread) {
      const placeholderUser: ThreadMessage = {
        id: nextId(),
        role: "user",
        text: "",
        files: [],
        toolCalls: [],
        status: "complete",
        timestamp: apiMessage.timestamp
          ? new Date(apiMessage.timestamp).getTime()
          : Date.now(),
        clientMessageId: threadId,
      };
      thread = {
        id: threadId,
        userMsg: placeholderUser,
        responses: [],
        pendingAssistant: null,
      };
      insertThreadInTimestampOrder(state, thread);
    }

    // If the pending assistant for this thread is still in-flight and the
    // committed message is the assistant's final reply, merge it.
    if (
      apiMessage.role === "assistant" &&
      thread.pendingAssistant &&
      thread.pendingAssistant.status === "streaming"
    ) {
      const finalized: ThreadMessage = {
        ...thread.pendingAssistant,
        text: apiMessage.content || thread.pendingAssistant.text,
        status: "complete",
        historySeq:
          typeof apiMessage.seq === "number"
            ? apiMessage.seq
            : thread.pendingAssistant.historySeq,
        intra_thread_seq:
          typeof apiMessage.seq === "number"
            ? apiMessage.seq
            : thread.pendingAssistant.intra_thread_seq,
      };
      thread.responses.push(finalized);
      thread.pendingAssistant = null;
      changed = true;
      sortResponsesInThread(thread);
      continue;
    }

    thread.responses.push(buildResponseFromApi(apiMessage));
    sortResponsesInThread(thread);
    changed = true;
  }

  if (changed) {
    state.threads.sort((a, b) => a.userMsg.timestamp - b.userMsg.timestamp);
    notify();
    // Index files into the global file store so the file panel sees them.
    for (const thread of state.threads) {
      const all = [
        thread.userMsg,
        ...thread.responses,
        ...(thread.pendingAssistant ? [thread.pendingAssistant] : []),
      ];
      for (const message of all) {
        for (const file of message.files) {
          indexFile(sessionId, file);
        }
      }
    }
  }
  return getMaxHistorySeq(sessionId, topic);
}

// ---------------------------------------------------------------------------
// Streaming-recovery helpers (reload during an active turn)
// ---------------------------------------------------------------------------

/** Ensure a thread has a pending streaming assistant for use during reload
 *  recovery. If the most recent thread already has one, reuse it; otherwise
 *  create a placeholder thread keyed by a synthesized id. Returns the
 *  thread id. */
export function ensureStreamingAssistantThread(
  sessionId: string,
  text = "Resuming ongoing work...",
  topic?: string,
): string {
  const key = storeKey(sessionId, topic);
  const state = ensureSession(key);

  for (let i = state.threads.length - 1; i >= 0; i -= 1) {
    const thread = state.threads[i];
    if (thread.pendingAssistant && thread.pendingAssistant.status === "streaming") {
      if (!thread.pendingAssistant.text && text) {
        thread.pendingAssistant.text = text;
        notify();
      }
      return thread.id;
    }
  }

  // No in-flight thread — synthesize a placeholder so streaming tokens have
  // somewhere to land. We don't have a user cmid here, so use a synthetic.
  const synthCmid = `recover-${nextId()}`;
  const placeholderUser: ThreadMessage = {
    id: nextId(),
    role: "user",
    text: "",
    files: [],
    toolCalls: [],
    status: "complete",
    timestamp: Date.now(),
    clientMessageId: synthCmid,
  };
  const pendingAssistant: ThreadMessage = {
    id: nextId(),
    role: "assistant",
    text,
    files: [],
    toolCalls: [],
    status: "streaming",
    timestamp: Date.now(),
    responseToClientMessageId: synthCmid,
  };
  const thread: Thread = {
    id: synthCmid,
    userMsg: placeholderUser,
    responses: [],
    pendingAssistant,
  };
  insertThreadInTimestampOrder(state, thread);
  notify();
  return thread.id;
}

function isResumePlaceholderText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed === "Resuming ongoing work...";
}

/** Reconcile recovery-time placeholder threads after we know whether the
 *  server stream is still active. Drops empty placeholders and finalizes
 *  partially-rendered ones to status "complete". */
export function reconcileRecoveredStreamingThreads(
  sessionId: string,
  topic?: string,
  options?: { streamActive?: boolean },
): void {
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return;

  const keepThreadId = options?.streamActive
    ? [...state.threads]
        .reverse()
        .find(
          (thread) =>
            thread.pendingAssistant &&
            thread.pendingAssistant.status === "streaming" &&
            typeof thread.pendingAssistant.historySeq !== "number",
        )?.id
    : undefined;

  let changed = false;
  const survivors: Thread[] = [];

  for (const thread of state.threads) {
    const pending = thread.pendingAssistant;
    if (
      !pending ||
      pending.status !== "streaming" ||
      typeof pending.historySeq === "number"
    ) {
      survivors.push(thread);
      continue;
    }

    if (keepThreadId && thread.id === keepThreadId) {
      survivors.push(thread);
      continue;
    }

    const hasMeaningfulState =
      !isResumePlaceholderText(pending.text) ||
      pending.files.length > 0 ||
      pending.toolCalls.length > 0;

    if (!options?.streamActive && !hasMeaningfulState) {
      // Drop this thread's placeholder pending; if the user message is
      // synthetic and empty, drop the whole thread too.
      const isSynthUser =
        thread.userMsg.text === "" && thread.userMsg.clientMessageId?.startsWith("recover-");
      if (isSynthUser && thread.responses.length === 0) {
        state.byId.delete(thread.id);
        changed = true;
        recordRuntimeCounter("octos_recovery_stream_cleanup_total", {
          action: "drop_placeholder",
        });
        continue;
      }
      thread.pendingAssistant = null;
      changed = true;
      recordRuntimeCounter("octos_recovery_stream_cleanup_total", {
        action: "drop_placeholder",
      });
      survivors.push(thread);
      continue;
    }

    const finalText =
      !options?.streamActive && isResumePlaceholderText(pending.text)
        ? ""
        : pending.text;
    thread.responses.push({
      ...pending,
      text: finalText,
      status: "complete",
    });
    thread.pendingAssistant = null;
    changed = true;
    sortResponsesInThread(thread);
    recordRuntimeCounter("octos_recovery_stream_cleanup_total", {
      action: "finalize_orphan",
    });
    survivors.push(thread);
  }

  if (!changed) return;
  state.threads = survivors;
  notify();
}
