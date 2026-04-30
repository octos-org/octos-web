/**
 * Thread store — thread-by-cmid chat data model (M8.10 PR #3, issue #627).
 *
 * Replaces the flat-list semantic from `message-store.ts`. Every user
 * message roots a `Thread` keyed by its `client_message_id`. Assistant and
 * tool messages bind to the thread via `response_to_client_message_id` (=
 * `thread_id` from PR #2's SSE events). Conversations are an ordered list
 * of threads sorted by `userMsg.timestamp` — no timestamp-primary sort
 * within a thread, no `Number.MAX_SAFE_INTEGER` fallback.
 *
 * The store is feature-flag gated. Activated only when
 * `localStorage.octos_thread_store_v2 === '1'`. Otherwise the existing
 * flat-list `message-store.ts` remains the default code path. PR #5
 * flips the flag default and deletes `message-store.ts`.
 *
 * Public API mirrors the shape of `message-store.ts` so the renderer
 * (PR #4) can swap stores without rebuilding its component tree.
 */

import { useSyncExternalStore } from "react";
import { getMessages as fetchMessages } from "@/api/sessions";
import type { MessageInfo } from "@/api/types";
import { displayFilenameFromPath } from "@/lib/utils";
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

/** Lookup a thread by id across every active session. Used by mutators
 *  that take a thread_id without an explicit session — the cmid is
 *  globally unique so this is unambiguous. */
function findThreadById(
  threadId: string,
): { state: SessionState; thread: Thread } | null {
  for (const state of sessionsByKey.values()) {
    const thread = state.byId.get(threadId);
    if (thread) return { state, thread };
  }
  return null;
}

/** Pick a "best guess" session to host a brand-new orphan thread bucket
 *  created in response to a late background event whose user message we
 *  never saw (page reload, multi-tab, etc.). Picks the session with the
 *  most-recent thread; falls back to the only-known session. Returns null
 *  when no sessions are tracked at all. */
function pickHostSessionForOrphan(): SessionState | null {
  let best: { state: SessionState; ts: number } | null = null;
  for (const state of sessionsByKey.values()) {
    if (state.threads.length === 0) {
      if (!best) best = { state, ts: 0 };
      continue;
    }
    const lastTs = state.threads[state.threads.length - 1].userMsg.timestamp;
    if (!best || lastTs > best.ts) best = { state, ts: lastTs };
  }
  return best?.state ?? null;
}

/** Create an orphan thread bucket for a late event whose user message
 *  was never added to the store (e.g. mid-stream page reload, late
 *  background tool_progress that arrives after history hydration). The
 *  user bubble shows as a placeholder so the conversation stays visible
 *  and the late assistant content lands in the right place. */
function ensureOrphanThread(threadId: string): {
  state: SessionState;
  thread: Thread;
} | null {
  const found = findThreadById(threadId);
  if (found) return found;
  const host = pickHostSessionForOrphan();
  if (!host) return null;
  const placeholderUser: ThreadMessage = {
    id: nextId(),
    role: "user",
    text: "",
    files: [],
    toolCalls: [],
    status: "complete",
    timestamp: Date.now(),
    clientMessageId: threadId,
  };
  const thread: Thread = {
    id: threadId,
    userMsg: placeholderUser,
    responses: [],
    pendingAssistant: null,
  };
  insertThreadInTimestampOrder(host, thread);
  recordRuntimeCounter("octos_thread_orphan_created_total", {
    surface: "thread_store",
  });
  return { state: host, thread };
}

/** Pick the assistant slot to mutate for a late event on this thread.
 *  Prefer the in-flight `pendingAssistant`; fall back to the most recent
 *  finalized assistant response so background tool_progress / file
 *  events that arrive AFTER `done` still land on the right bubble.
 *  Returns null if neither exists (caller may decide to create a new
 *  pending). */
function pickAssistantSlot(thread: Thread): ThreadMessage | null {
  if (thread.pendingAssistant) return thread.pendingAssistant;
  for (let i = thread.responses.length - 1; i >= 0; i -= 1) {
    if (thread.responses[i].role === "assistant") return thread.responses[i];
  }
  return null;
}

/** Get-or-create the in-flight assistant slot for a thread. Used when
 *  fresh assistant content (token / replace) arrives after the original
 *  pending was finalized — we open a follow-on pending so the new text
 *  has somewhere to render. */
function ensurePendingAssistant(thread: Thread): ThreadMessage {
  if (!thread.pendingAssistant) {
    thread.pendingAssistant = makeAssistantPlaceholder(thread.id);
  }
  return thread.pendingAssistant;
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

  // If a thread already exists with this id, adopt it instead of
  // double-inserting. Two flavours:
  //  • Orphan bucket — created earlier by a late background event whose
  //    user message hadn't been added yet. Preserve its `responses` and
  //    in-flight `pendingAssistant` (codex review #2: replacing them
  //    with an empty placeholder would discard runtime progress).
  //  • Hydrated history thread — `responses` is already populated and
  //    `pendingAssistant` is null. Open a fresh pending for the new turn.
  const existing = state.byId.get(opts.clientMessageId);
  if (existing) {
    existing.userMsg = userMsg;
    if (!existing.pendingAssistant) {
      existing.pendingAssistant = pendingAssistant;
    }
    notify();
    return {
      threadId: opts.clientMessageId,
      pendingAssistantId: existing.pendingAssistant.id,
    };
  }

  // Adopt any orphan thread bucket that was created earlier (a late
  // background event arrived ahead of the user message) — even if it
  // landed in a different session's state. Carry over its responses
  // and in-flight pending so the runtime progress isn't dropped.
  for (const otherState of sessionsByKey.values()) {
    if (otherState === state) continue;
    const orphan = otherState.byId.get(opts.clientMessageId);
    if (!orphan) continue;
    const adopted: Thread = {
      id: opts.clientMessageId,
      userMsg,
      responses: orphan.responses,
      pendingAssistant: orphan.pendingAssistant ?? pendingAssistant,
    };
    // Detach from the wrong session.
    otherState.byId.delete(opts.clientMessageId);
    const idx = otherState.threads.indexOf(orphan);
    if (idx !== -1) otherState.threads.splice(idx, 1);
    insertThreadInTimestampOrder(state, adopted);
    notify();
    return {
      threadId: adopted.id,
      pendingAssistantId: adopted.pendingAssistant!.id,
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
  const found = ensureOrphanThread(threadId);
  if (!found) return;
  // New text means a new turn — open a fresh pending slot if the old one
  // was already finalized (background follow-up message).
  const slot = ensurePendingAssistant(found.thread);
  slot.text += token;
  notify();
}

export function replaceAssistantText(threadId: string, text: string): void {
  const found = ensureOrphanThread(threadId);
  if (!found) return;
  const slot = ensurePendingAssistant(found.thread);
  slot.text = text;
  notify();
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
  const found = ensureOrphanThread(threadId);
  if (!found) return;
  // Prefer an existing assistant slot — the in-flight pending or the
  // most recent finalized response. Late/replayed tool_start events
  // arriving after finalize attach to the existing finalized response
  // rather than spawning a phantom streaming bubble that never gets a
  // `done` (codex review #1).
  let slot = pickAssistantSlot(found.thread);
  // Idempotency: if the tool_call_id is already attached to ANY
  // assistant slot in this thread, just update its status. Avoids
  // double-renders when a tool_start replays.
  for (const candidate of [
    found.thread.pendingAssistant,
    ...[...found.thread.responses].reverse(),
  ]) {
    if (!candidate) continue;
    const idx = candidate.toolCalls.findIndex((tc) => tc.id === toolCallId);
    if (idx !== -1) {
      candidate.toolCalls[idx] = {
        ...candidate.toolCalls[idx],
        status: "running",
      };
      notify();
      return;
    }
  }
  // No assistant ever existed on this thread (orphan with no responses
  // at all) → bootstrap a pending so the tool has somewhere to render.
  if (!slot) {
    slot = ensurePendingAssistant(found.thread);
  }

  const tcs = slot.toolCalls;
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
}

/** Maximum runtime progress entries kept per tool call. Old entries are
 *  evicted FIFO so a long-running pipeline that emits hundreds of
 *  `tool_progress` events (or replayed `task_status` mirrors) cannot
 *  blow up the per-bubble timeline render cost or grow memory without
 *  bound. */
const MAX_TOOL_PROGRESS_ENTRIES = 100;

export function appendToolProgress(
  threadId: string,
  toolCallId: string,
  message: string,
): void {
  if (!message) return;
  const found = ensureOrphanThread(threadId);
  if (!found) return;
  // Prefer the in-flight pending; fall back to the most recent finalized
  // assistant so a late spawn_only tool_progress (#649) still updates
  // the bubble even after `done` finalized the turn.
  const slot = pickAssistantSlot(found.thread);
  // No assistant slot at all yet (e.g. orphan thread, never had one) —
  // open a new pending so the progress has somewhere to render.
  const target = slot ?? ensurePendingAssistant(found.thread);

  const tcs = target.toolCalls;
  let entry = tcs.find((tc) => tc.id === toolCallId);
  if (!entry) {
    // Late-arriving progress for a tool whose start we missed (e.g. SSE
    // resumed mid-stream). Create a stub call so the progress isn't lost.
    entry = {
      id: toolCallId,
      name: "",
      status: "running",
      progress: [],
      retryCount: 0,
    };
    tcs.push(entry);
  }
  // Idempotency guard: skip exact-duplicate consecutive entries so a
  // task_status replay (e.g. on stream reconnect) doesn't double-render
  // the same line in the timeline. Mirrors the logic in
  // `MessageStore.appendToolProgressByCallId`.
  const lastEntry = entry.progress[entry.progress.length - 1];
  if (lastEntry && lastEntry.message === message) {
    return;
  }
  entry.progress.push({ message, ts: Date.now() });
  if (entry.progress.length > MAX_TOOL_PROGRESS_ENTRIES) {
    entry.progress.splice(
      0,
      entry.progress.length - MAX_TOOL_PROGRESS_ENTRIES,
    );
  }
  notify();
}

export function setToolCallStatus(
  threadId: string,
  toolCallId: string,
  status: ThreadToolCall["status"],
): void {
  const found = ensureOrphanThread(threadId);
  if (!found) return;
  const slot = pickAssistantSlot(found.thread);
  if (!slot) return;
  const tcs = slot.toolCalls;
  const idx = tcs.findIndex((tc) => tc.id === toolCallId);
  if (idx === -1) return;
  tcs[idx] = { ...tcs[idx], status };
  notify();
}

/** Append a delivered file to the assistant slot in the thread (pending
 *  in-flight, or the most recent finalized response if the turn has
 *  already ended — the late-arrival case for spawn_only background
 *  tasks). */
export function appendAssistantFile(
  threadId: string,
  file: MessageFile,
): boolean {
  const found = ensureOrphanThread(threadId);
  if (!found) return false;
  const slot = pickAssistantSlot(found.thread) ?? ensurePendingAssistant(found.thread);
  if (slot.files.some((f) => f.path === file.path)) return true;
  slot.files = [...slot.files, file];
  notify();
  return true;
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
  // Carry over any in-flight pending assistants from the previous state
  // so a replay triggered by retry-fetch (or by a tab regaining focus)
  // doesn't wipe runtime progress that hasn't been persisted yet.
  // Codex review #2.
  const previous = sessionsByKey.get(key);
  const carryPending = new Map<string, ThreadMessage>();
  if (previous) {
    for (const t of previous.threads) {
      if (t.pendingAssistant) carryPending.set(t.id, t.pendingAssistant);
    }
  }
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
          pendingAssistant: carryPending.get(threadId) ?? null,
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
        pendingAssistant: carryPending.get(threadId) ?? null,
      };
      state.byId.set(threadId, thread);
      state.threads.push(thread);
    }

    thread.responses.push(buildResponseFromApi(apiMessage));
  }

  // Re-attach any in-flight pendings that didn't surface in the API
  // response yet (e.g. a fresh background turn whose user message lives
  // only in the live store). They show up as user-rooted threads carried
  // forward verbatim.
  for (const [tid, pending] of carryPending) {
    if (state.byId.has(tid)) continue;
    if (previous) {
      const prevThread = previous.byId.get(tid);
      if (prevThread) {
        const carried: Thread = {
          id: tid,
          userMsg: prevThread.userMsg,
          responses: prevThread.responses,
          pendingAssistant: pending,
        };
        state.byId.set(tid, carried);
        state.threads.push(carried);
      }
    }
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

export interface LoadHistoryOptions {
  /**
   * Bypass the per-session "already loaded" cache and force a fresh fetch.
   * Used to recover from server persistence latency on reload — when the
   * client loads /messages immediately after a streaming `done` event the
   * JSONL may still be catching up, so the first fetch returns the user
   * messages but not the assistant ones. The mount effect retries with
   * `force: true` after a short delay to re-hydrate assistants once the
   * server commits them.
   */
  force?: boolean;
}

export function loadHistory(
  sessionId: string,
  topic?: string,
  options: LoadHistoryOptions = {},
): Promise<void> {
  const key = storeKey(sessionId, topic);
  if (!options.force && loadedSessions.has(key)) return Promise.resolve();

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
  } else {
    for (const k of [...sessionsByKey.keys()]) {
      if (k === sessionId || k.startsWith(`${sessionId}#`)) {
        sessionsByKey.delete(k);
        loadedSessions.delete(k);
        loadingPromises.delete(k);
      }
    }
  }
  notify();
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
// Tool-call → thread_id reverse lookup
// ---------------------------------------------------------------------------

/**
 * Find the thread_id that owns the given `toolCallId` in this session, if
 * any. Returns null when the tool call has not been registered (yet) or
 * when the v2 thread store is empty for the session.
 *
 * Scans `pendingAssistant` first (in-flight turn) then finalized
 * `responses` (most-recent-first) so a still-running deep_research bubble
 * resolves before its post-completion sibling. Used by the runtime
 * provider to mirror task_status transitions into the corresponding
 * tool-call's progress timeline (issue #649 follow-up).
 */
export function findThreadIdForToolCall(
  sessionId: string,
  topic: string | undefined,
  toolCallId: string,
): string | null {
  if (!toolCallId) return null;
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return null;
  for (let i = state.threads.length - 1; i >= 0; i -= 1) {
    const thread = state.threads[i];
    if (thread.pendingAssistant?.toolCalls.some((tc) => tc.id === toolCallId)) {
      return thread.id;
    }
    for (let j = thread.responses.length - 1; j >= 0; j -= 1) {
      if (thread.responses[j].toolCalls.some((tc) => tc.id === toolCallId)) {
        return thread.id;
      }
    }
  }
  return null;
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
  version = 0;
  idCounter = 0;
}
