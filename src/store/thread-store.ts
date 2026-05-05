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

/** Late streaming chunks (`token` / `replace`) for an already-finalized
 *  thread are cross-talk artifacts from concurrent same-chat streams.
 *  Pre-fix, `ensurePendingAssistant` unconditionally created a fresh
 *  pending slot for them — which the renderer painted as a phantom
 *  assistant bubble (`filled=8/5` on a 5-message scenario, observed on
 *  mini1 after #680). Drop the event and bump a counter instead.
 *
 *  A thread is "finalized" when it has at least one assistant response
 *  AND no in-flight pending. New turns on the same chat get their OWN
 *  thread (rooted at a fresh client_message_id) — there is no legitimate
 *  case where streaming text should reopen a finalized thread bucket. */
function isFinalizedAndIdle(thread: Thread): boolean {
  if (thread.pendingAssistant) return false;
  return thread.responses.some((r) => r.role === "assistant");
}

export function appendAssistantToken(threadId: string, token: string): void {
  const found = ensureOrphanThread(threadId);
  if (!found) return;
  if (isFinalizedAndIdle(found.thread)) {
    recordRuntimeCounter("octos_thread_phantom_chunk_dropped_total", {
      surface: "thread_store",
      kind: "token",
    });
    return;
  }
  const slot = ensurePendingAssistant(found.thread);
  slot.text += token;
  notify();
}

export function replaceAssistantText(threadId: string, text: string): void {
  const found = ensureOrphanThread(threadId);
  if (!found) return;
  if (isFinalizedAndIdle(found.thread)) {
    recordRuntimeCounter("octos_thread_phantom_chunk_dropped_total", {
      surface: "thread_store",
      kind: "replace",
    });
    return;
  }
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
  // Skip the by-id match when id is empty (legacy server path) so we
  // don't accidentally collapse two distinct calls that both lack an
  // id; fall through to the by-name retry-collapse instead.
  if (toolCallId) {
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
  }
  // No assistant ever existed on this thread (orphan with no responses
  // at all) → bootstrap a pending so the tool has somewhere to render.
  if (!slot) {
    slot = ensurePendingAssistant(found.thread);
  }

  const tcs = slot.toolCalls;
  // Already known by id → idempotent (re-issued tool_start, replay).
  // Skip when id is empty so two distinct empty-id calls don't collapse.
  if (toolCallId) {
    const byId = tcs.findIndex((tc) => tc.id === toolCallId);
    if (byId !== -1) {
      tcs[byId] = { ...tcs[byId], status: "running" };
      notify();
      return;
    }
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
  toolName?: string,
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
  let entry: ThreadToolCall | undefined;
  if (toolCallId) {
    entry = tcs.find((tc) => tc.id === toolCallId);
  } else if (toolName) {
    // Server omitted tool_call_id (legacy daemon). Route by tool name to
    // the most recent matching call so progress still lands on the right
    // bubble — no synthesized id required.
    for (let i = tcs.length - 1; i >= 0; i -= 1) {
      if (tcs[i].name === toolName) {
        entry = tcs[i];
        break;
      }
    }
  }
  if (!entry) {
    // Late-arriving progress for a tool whose start we missed (e.g. SSE
    // resumed mid-stream). Create a stub call so the progress isn't lost.
    entry = {
      id: toolCallId,
      name: toolName ?? "",
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
  toolName?: string,
): void {
  const found = ensureOrphanThread(threadId);
  if (!found) return;
  const slot = pickAssistantSlot(found.thread);
  if (!slot) return;
  const tcs = slot.toolCalls;
  let idx = -1;
  if (toolCallId) {
    idx = tcs.findIndex((tc) => tc.id === toolCallId);
  } else if (toolName) {
    // Legacy daemon path — route by tool name to the most recent match.
    for (let i = tcs.length - 1; i >= 0; i -= 1) {
      if (tcs[i].name === toolName) {
        idx = i;
        break;
      }
    }
  }
  if (idx === -1) return;
  tcs[idx] = { ...tcs[idx], status };
  notify();
}

/**
 * M10 Phase 2 (server PR #772): append a NEW assistant row to the thread
 * for a `turn/spawn_complete` envelope. Distinct from `appendAssistantFile`
 * + `appendPersistedMessage`, which both splice late media into the
 * existing assistant bubble — that splice-merge predicate is the bug
 * surface M10 deletes (Phase 5). This function ALWAYS adds a fresh
 * `ThreadMessage` to `thread.responses` so multiple assistant bubbles
 * render under the originating user prompt (the renderer's
 * `responses.map` already supports N-bubbles per user message).
 *
 * Returns `true` when a row was appended, `false` when the thread could
 * not be located and could not be created (no live sessions). Idempotent
 * by `(threadId, historySeq)` when `historySeq` is provided — a replayed
 * envelope on reconnect does not produce a duplicate row.
 */
export interface AppendCompletionBubbleOptions {
  text: string;
  media: string[];
  /** Marker so the renderer can style spawn-completion bubbles distinctly
   *  (Phase 3, optional). */
  spawnComplete: true;
  /** Originating user prompt cmid, when available (Phase 4 will populate
   *  it server-side). Captured for future audit / hover tooltips. */
  sourceClientMessageId?: string;
  /** Server-assigned per-session seq for dedupe on reconnect replay. */
  historySeq?: number;
  /** Server-assigned message id for stable identity across replays. */
  messageId?: string;
  /** Server-side `persisted_at` (RFC 3339). When supplied, the row's
   *  display timestamp uses this server-authoritative value rather than
   *  client receipt time, so reconnect/replay produces a stable order
   *  matching the hydrated history. Codex round-4 P3 (delivered envelopes
   *  whose `persisted_at` differed from receipt time would render with
   *  a moving timestamp). */
  persistedAt?: string;
  /** Active router scope. When the envelope's `thread_id` does not
   *  already exist in any session, the orphan-bucket helper creates it
   *  HERE rather than picking an arbitrary host session — without this,
   *  a stale previously-loaded session in `sessionsByKey` could swallow
   *  the bubble (codex P2: orphan completions misplaced after
   *  reload/session-switch). */
  sessionId?: string;
  topic?: string;
}

export function appendCompletionBubble(
  threadId: string,
  opts: AppendCompletionBubbleOptions,
): boolean {
  // Resolve the host thread. Prefer an exact match anywhere in the
  // store (M8.10 cross-session cmid semantics). When no match exists,
  // create the orphan inside the router's active session so
  // session-switch / reload scenarios don't silently route the bubble
  // into a stale session bucket.
  let host = findThreadById(threadId);
  if (!host) {
    if (opts.sessionId) {
      const state = ensureSession(storeKey(opts.sessionId, opts.topic));
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
      const orphan: Thread = {
        id: threadId,
        userMsg: placeholderUser,
        responses: [],
        pendingAssistant: null,
      };
      insertThreadInTimestampOrder(state, orphan);
      recordRuntimeCounter("octos_thread_orphan_created_total", {
        surface: "thread_store_completion",
      });
      host = { state, thread: orphan };
    } else {
      // No router scope provided — fall back to legacy orphan placement
      // (covers test paths that don't supply sessionId; production
      // callers should always pass it).
      host = ensureOrphanThread(threadId);
    }
  }
  if (!host) return false;
  const { thread } = host;

  // Identity / upgrade-in-place. A replayed envelope on reconnect
  // MUST NOT produce a duplicate row. Two stable identities exist:
  //
  //   • messageId  — Phase 1 P2-B fix reuses the persisted row's
  //                  `message_id` on the envelope, so the spawn-complete
  //                  envelope's id MATCHES its companion `message/persisted`
  //                  but is DISTINCT from the spawn-ack's id. This is
  //                  the strongest dedupe key.
  //   • historySeq — `seq` is a per-session committed-row index. Robust
  //                  for clean cases; but see the codex round-5 edge:
  //                  legacy `replayHistory` (via `mergeMediaCompanionInto`)
  //                  can MOVE a media-only companion's `historySeq` onto
  //                  the preceding ack bubble, so finding `historySeq=N`
  //                  on a non-empty row does NOT prove that row IS the
  //                  spawn-complete row.
  //
  // Strategy: prefer `messageId` for the identity check. Fall back to
  // `historySeq` only as a placeholder-upgrade hint — when we find a
  // row with the same seq AND it has empty text (the persisted-only
  // placeholder shape), upgrade in place. Non-empty-text rows at the
  // matching seq are NOT considered duplicates: they may be merged ack
  // rows whose seq was donated by a media-only companion. In that case
  // we proceed to append a fresh row, which is the correct M10
  // separate-bubble semantic.

  if (opts.messageId) {
    for (let i = 0; i < thread.responses.length; i += 1) {
      const r = thread.responses[i];
      if (r.id !== opts.messageId) continue;
      // True identity match — this row IS the spawn-complete row.
      // Upgrade-in-place if it's a placeholder (the persisted-only
      // shape), no-op if it's already the full completion.
      if (r.text.length > 0) return true;
      thread.responses[i] = upgradePlaceholderRow(r, opts, threadId);
      sortResponsesInThread(thread);
      notify();
      return true;
    }
    if (thread.pendingAssistant?.id === opts.messageId) return true;
  }

  if (typeof opts.historySeq === "number") {
    for (let i = 0; i < thread.responses.length; i += 1) {
      const r = thread.responses[i];
      if (r.historySeq !== opts.historySeq) continue;
      // Only a PLACEHOLDER row at the matching seq is the legitimate
      // upgrade target. If the row has non-empty text it is either:
      //   (a) a merged-ack row whose seq was donated by replayHistory's
      //       media-only-companion merge — NOT this completion, so
      //       fall through to append a fresh row;
      //   (b) the spawn-complete row already filled in by an earlier
      //       call (true replay; messageId match would have caught it
      //       above unless callers omit messageId — test paths).
      // We can't distinguish (a) from (b) reliably without messageId,
      // so we fall through and let the append path take care of it.
      // For (b) test-path callers, the next-best identity is "same
      // text + same media list"; if that matches, treat as no-op.
      if (r.text.length > 0) {
        if (rowMatchesCompletionContent(r, opts)) return true;
        continue; // (a): merged-ack row, not our target
      }
      thread.responses[i] = upgradePlaceholderRow(r, opts, threadId);
      sortResponsesInThread(thread);
      notify();
      return true;
    }
    if (thread.pendingAssistant?.historySeq === opts.historySeq) return true;
  }

  const completion: ThreadMessage = {
    id: opts.messageId ?? nextId(),
    role: "assistant",
    text: opts.text,
    files: opts.media.map(fileFromMediaPath),
    toolCalls: [],
    status: "complete",
    // Prefer the server-side commit time. Falling back to client
    // receipt time for callers that don't supply it (test paths) is
    // safe; production callers always set `persistedAt` from the
    // envelope's `persisted_at` field.
    timestamp: parsePersistedAt(opts.persistedAt),
    historySeq: opts.historySeq,
    intra_thread_seq: opts.historySeq,
    responseToClientMessageId: opts.sourceClientMessageId ?? threadId,
  };
  thread.responses.push(completion);
  sortResponsesInThread(thread);
  notify();
  return true;
}

function parsePersistedAt(persistedAt: string | undefined): number {
  if (!persistedAt) return Date.now();
  const t = new Date(persistedAt).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

/** Replace a placeholder row's empty text + (optional) files with the
 *  spawn-complete envelope's authoritative content, unioning files by
 *  path so a file already landed by the persisted-only row isn't lost
 *  or duplicated. Used for both `messageId` and `historySeq` upgrade
 *  paths. */
function upgradePlaceholderRow(
  existing: ThreadMessage,
  opts: AppendCompletionBubbleOptions,
  threadId: string,
): ThreadMessage {
  const incomingFiles = opts.media.map(fileFromMediaPath);
  const seen = new Set<string>();
  const mergedFiles: MessageFile[] = [];
  for (const f of [...existing.files, ...incomingFiles]) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    mergedFiles.push(f);
  }
  return {
    ...existing,
    text: opts.text,
    files: mergedFiles,
    historySeq: opts.historySeq ?? existing.historySeq,
    intra_thread_seq: opts.historySeq ?? existing.intra_thread_seq,
    responseToClientMessageId:
      opts.sourceClientMessageId ??
      existing.responseToClientMessageId ??
      threadId,
  };
}

/** Best-effort content match for the dedupe-by-historySeq fallback
 *  when callers omit `messageId`. Same text and same file path set
 *  means this row IS the spawn-complete row already (true replay,
 *  no-op). Different content means the seq was likely donated by
 *  legacy `replayHistory` media-only-companion merging — in that case
 *  the caller should append a fresh row, not dedupe. */
function rowMatchesCompletionContent(
  row: ThreadMessage,
  opts: AppendCompletionBubbleOptions,
): boolean {
  if (row.text !== opts.text) return false;
  if (row.files.length !== opts.media.length) return false;
  const rowPaths = new Set(row.files.map((f) => f.path));
  for (const path of opts.media) {
    if (!rowPaths.has(path)) return false;
  }
  return true;
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

    // Sweep any still-running tool calls to "complete" — the assistant
    // turn ended, so a tool whose explicit `tool_end` was suppressed or
    // lost over the wire would otherwise leave the chip spinning forever.
    // Only flip running → complete; preserve "error" and existing
    // "complete" entries (tool_end already arrived for those).
    const sweptToolCalls = thread.pendingAssistant.toolCalls.map((tc) =>
      tc.status === "running" ? { ...tc, status: "complete" as const } : tc,
    );

    const finalized: ThreadMessage = {
      ...thread.pendingAssistant,
      toolCalls: sweptToolCalls,
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

/** Detect a "media-only companion" assistant record — a follow-on bubble
 *  that carries just the report's audio/podcast/etc. with no original text
 *  of its own. Common shapes:
 *    • completely empty content
 *    • content is only a `[file: ...]` placeholder line
 *    • content is just whitespace
 *  Used by adjacent-merge in `replayHistory` to fold the companion into
 *  its preceding text record so the user sees one bubble, not two. */
function isMediaOnlyCompanion(m: ThreadMessage): boolean {
  if (m.files.length === 0) return false;
  if (m.toolCalls.length > 0) return false;
  const trimmed = m.text.trim();
  if (trimmed.length === 0) return true;
  // Strip [file: ...] markers; if nothing else remains it's media-only.
  const stripped = trimmed.replace(/\[file:[^\]]*\]/gi, "").trim();
  return stripped.length === 0;
}

/** Merge a media-only companion's files into the preceding assistant
 *  record. Dedupes by `path`, preserves
 *  `historySeq = max(prev.historySeq, companion.historySeq)` so later
 *  ordering stays correct. */
function mergeMediaCompanionInto(
  prev: ThreadMessage,
  companion: ThreadMessage,
): void {
  const seenPaths = new Set(prev.files.map((f) => f.path));
  for (const f of companion.files) {
    if (!seenPaths.has(f.path)) {
      prev.files.push(f);
      seenPaths.add(f.path);
    }
  }
  const prevSeq = prev.historySeq ?? Number.NEGATIVE_INFINITY;
  const compSeq = companion.historySeq ?? Number.NEGATIVE_INFINITY;
  if (compSeq > prevSeq) {
    prev.historySeq = companion.historySeq;
    prev.intra_thread_seq = companion.intra_thread_seq ?? prev.intra_thread_seq;
  }
}

/** Locate a prior assistant response in the same thread that already
 *  carries at least one of the incoming record's file paths AND whose
 *  text either matches the incoming text verbatim or is empty (in
 *  either direction). Returns -1 when no duplicate exists. */
function findDuplicateAssistantWithFile(
  responses: ThreadMessage[],
  incoming: ThreadMessage,
): number {
  const incomingPaths = new Set(incoming.files.map((f) => f.path));
  if (incomingPaths.size === 0) return -1;
  const incomingText = incoming.text.trim();
  for (let i = responses.length - 1; i >= 0; i -= 1) {
    const r = responses[i];
    if (r.role !== "assistant") continue;
    if (r.files.length === 0) continue;
    const hasOverlap = r.files.some((f) => incomingPaths.has(f.path));
    if (!hasOverlap) continue;
    const rText = r.text.trim();
    const textsCompatible =
      rText === incomingText ||
      rText.length === 0 ||
      incomingText.length === 0;
    if (textsCompatible) return i;
  }
  return -1;
}

/** Merge `incoming` into `prev` for the duplicate-file collapse: union
 *  the file lists by path, prefer non-empty text, and preserve
 *  `historySeq = max(...)`. */
function mergeDuplicateAssistantFile(
  prev: ThreadMessage,
  incoming: ThreadMessage,
): void {
  const seenPaths = new Set(prev.files.map((f) => f.path));
  for (const f of incoming.files) {
    if (!seenPaths.has(f.path)) {
      prev.files.push(f);
      seenPaths.add(f.path);
    }
  }
  if (prev.text.trim().length === 0 && incoming.text.trim().length > 0) {
    prev.text = incoming.text;
  }
  const prevSeq = prev.historySeq ?? Number.NEGATIVE_INFINITY;
  const incSeq = incoming.historySeq ?? Number.NEGATIVE_INFINITY;
  if (incSeq > prevSeq) {
    prev.historySeq = incoming.historySeq;
    prev.intra_thread_seq = incoming.intra_thread_seq ?? prev.intra_thread_seq;
  }
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
    // Codex review #3: prefer the explicit per-thread sequence when the
    // server emitted one (UI Protocol v1 PersistedMessage). Legacy REST
    // history responses don't carry a separate intra_thread_seq, so
    // `m.seq` (per-session) is the only axis available — fall back to it.
    intra_thread_seq:
      typeof m.intra_thread_seq === "number"
        ? m.intra_thread_seq
        : typeof m.seq === "number"
          ? m.seq
          : undefined,
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

    const built = buildResponseFromApi(apiMessage);

    // Adjacent media-only companion coalescing: deep_research returns a
    // text report (record N) immediately followed by a media-only file
    // delivery (record N+1) that carries the audio/podcast as files but
    // no new text of its own. Render them as ONE bubble with text +
    // attached files instead of two.
    //
    // Conditions: both records are assistant-role on the same thread,
    // historySeq is exactly +1 (no other records between them), and the
    // incoming record matches `isMediaOnlyCompanion`.
    if (
      built.role === "assistant" &&
      isMediaOnlyCompanion(built) &&
      thread.responses.length > 0
    ) {
      const last = thread.responses[thread.responses.length - 1];
      const lastSeq = last.historySeq;
      const builtSeq = built.historySeq;
      if (
        last.role === "assistant" &&
        typeof lastSeq === "number" &&
        typeof builtSeq === "number" &&
        builtSeq === lastSeq + 1 &&
        last.text.trim().length > 0
      ) {
        mergeMediaCompanionInto(last, built);
        continue;
      }
    }

    // Duplicate assistant+file collapse: a prior assistant record on the
    // same thread already carries one or more of the incoming record's
    // file paths (overlap) AND the text either matches verbatim or one
    // side is empty. This handles the replay shape where the persistence
    // layer wrote both a streaming snapshot and a final delivery for the
    // same file. Without this, the user sees two assistant bubbles with
    // the same MP3/PNG attached.
    if (
      built.role === "assistant" &&
      built.files.length > 0 &&
      thread.responses.length > 0
    ) {
      const dupIdx = findDuplicateAssistantWithFile(thread.responses, built);
      if (dupIdx !== -1) {
        mergeDuplicateAssistantFile(thread.responses[dupIdx], built);
        continue;
      }
    }

    thread.responses.push(built);
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

/**
 * Ingest a single persisted `MessageInfo` (e.g. from a `session_result` SSE
 * event) into the appropriate thread without replaying the whole session.
 *
 * Closes the M8.10 wave-6 leak: pre-fix, late `session_result` events for
 * deep_research / mofa / run_pipeline turns landed only in the legacy
 * MessageStore — which the v2 renderer ignores — leaving the v2 UI stuck on
 * the finalized spawn-ack. Now the `sse-bridge` handler also calls this
 * helper so the persisted record reaches `ThreadStore.responses`.
 *
 * Routing:
 *   • Use `message.thread_id` when present (server stamps it for both the
 *     non-media and media-bearing `_session_result` paths).
 *   • Fall back to `deriveLegacyThreadId` for legacy daemons that omit it.
 *
 * Merge: applies the same media-only-companion and duplicate-assistant-file
 * rules `replayHistory` uses against the existing tail of the thread, so a
 * late audio/podcast delivery folds into the spawn-ack assistant bubble
 * instead of producing an orphan duplicate.
 *
 * Idempotent: a second call for the same `historySeq` (from a replay) is a
 * no-op.
 *
 * Notes:
 *   • Does NOT touch `pendingAssistant` — a different turn in the same
 *     thread may still be running (rare but possible during overlap).
 *   • Skips `system` messages (mirrors `replayHistory`).
 */
export function appendPersistedMessage(
  sessionId: string,
  topic: string | undefined,
  message: MessageInfo,
): void {
  if (message.role === "system") return;

  // Prefer the explicit thread_id stamped by the server. For legacy
  // daemons that omit it, walk the obvious fallbacks before reaching for
  // `deriveLegacyThreadId` (which synthesizes a fresh id for an
  // assistant record with no ambient context — wrong for a single late
  // session_result delivery).
  const directThreadId =
    message.thread_id ||
    message.response_to_client_message_id ||
    (message.role === "user" ? message.client_message_id : undefined);
  const ctx = { currentThreadId: null as string | null };
  const threadId = directThreadId || deriveLegacyThreadId(message, ctx);
  if (!threadId) return;

  const key = storeKey(sessionId, topic);
  let state = sessionsByKey.get(key);

  // Locate (or adopt) the thread. Prefer the live session's bucket; fall
  // back to a globally-known thread (e.g. orphan bucket created earlier on
  // a different scope key); finally synthesize a placeholder so the late
  // record is at least visible.
  let thread: Thread | undefined = state?.byId.get(threadId);
  if (!thread) {
    const found = findThreadById(threadId);
    if (found) {
      state = found.state;
      thread = found.thread;
    }
  }
  if (!thread) {
    if (!state) {
      state = ensureSession(key);
    }
    const placeholderUser: ThreadMessage = {
      id: nextId(),
      role: "user",
      text: "",
      files: [],
      toolCalls: [],
      status: "complete",
      timestamp: message.timestamp
        ? new Date(message.timestamp).getTime()
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

  if (message.role === "user") {
    // Persisted user record echoing back through session_result — only
    // adopt its text/files if the existing user bubble is the empty
    // placeholder (orphan thread case). Don't clobber a real send.
    if (thread.userMsg.text === "" && thread.userMsg.files.length === 0) {
      const built = buildResponseFromApi(message);
      thread.userMsg = {
        ...thread.userMsg,
        text: built.text,
        files: built.files,
        historySeq: built.historySeq,
        intra_thread_seq: built.intra_thread_seq,
        clientMessageId: message.client_message_id ?? threadId,
      };
      notify();
    }
    return;
  }

  // Idempotency: skip if a response with the same historySeq is already in
  // the thread. The server-side seq is per-session monotonic so this is a
  // safe identity check — and the only one available since `MessageInfo`
  // has no stable id field.
  const incomingSeq = typeof message.seq === "number" ? message.seq : undefined;
  if (incomingSeq !== undefined) {
    for (const r of thread.responses) {
      if (r.historySeq === incomingSeq) return;
    }
  }

  const built = buildResponseFromApi(message);

  // Adjacent media-only companion: late media-bearing record whose text is
  // empty / a `[file:...]` marker folds into the prior text response on
  // this thread. Mirrors the `replayHistory` rule so the runtime path
  // produces the same shape as a fresh page load.
  if (
    built.role === "assistant" &&
    isMediaOnlyCompanion(built) &&
    thread.responses.length > 0
  ) {
    const last = thread.responses[thread.responses.length - 1];
    const lastSeq = last.historySeq;
    const builtSeq = built.historySeq;
    const adjacent =
      typeof lastSeq === "number" &&
      typeof builtSeq === "number" &&
      builtSeq === lastSeq + 1;
    if (
      adjacent &&
      last.role === "assistant" &&
      last.text.trim().length > 0
    ) {
      mergeMediaCompanionInto(last, built);
      notify();
      return;
    }
  }

  // Duplicate assistant+file collapse: a prior response on the same thread
  // already carries this media. Mirrors `replayHistory` so a streamed
  // snapshot followed by a persisted final delivery doesn't produce two
  // bubbles holding the same MP3/PNG.
  if (
    built.role === "assistant" &&
    built.files.length > 0 &&
    thread.responses.length > 0
  ) {
    const dupIdx = findDuplicateAssistantWithFile(thread.responses, built);
    if (dupIdx !== -1) {
      mergeDuplicateAssistantFile(thread.responses[dupIdx], built);
      notify();
      return;
    }
  }

  thread.responses.push(built);
  sortResponsesInThread(thread);
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
