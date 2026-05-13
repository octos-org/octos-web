/**
 * Thread store — thread-by-cmid chat data model (M8.10 PR #3, issue #627).
 *
 * Every user message roots a `Thread` keyed by its `client_message_id`.
 * Assistant and tool messages bind to the thread via
 * `response_to_client_message_id` (= `thread_id` from PR #2's SSE events).
 * Conversations are an ordered list of threads sorted by
 * `userMsg.timestamp` — no timestamp-primary sort within a thread, no
 * `Number.MAX_SAFE_INTEGER` fallback.
 *
 * M9-γ-6 (issue #843): the parallel legacy flat-list store has been
 * deleted; ThreadStore is the single source of truth for chat state.
 * The projection-mode shim (γ-3) translates every mutation entry point
 * into an `Envelope` and dual-writes it through `projection-store.ts`
 * when the `octos_projection_v1` flag is on; the legacy reducer that
 * builds `Thread[]` for `getThreads()` keeps running so the UI keeps
 * the same shape.
 */

import { useSyncExternalStore } from "react";
// M12 Phase D-3: history panel routes through the Phase D-2
// `getMessages` wrapper in src/api/sessions.ts, which flips between
// the WS `session/messages_page` method and the legacy REST
// `/api/sessions/:id/messages` endpoint under the
// `auxiliary_rest_to_ws_v1` flag. The wrapper preserves the array
// return shape that `replayHistory` consumes; pagination metadata
// (`has_more` / `next_offset`) drives the paged loader below
// (issue #110.3 — silent 500-msg truncation).
import { getMessagesPage } from "@/api/sessions";
import type { MessageInfo } from "@/api/types";
import { displayFilenameFromPath } from "@/lib/utils";
import { recordRuntimeCounter } from "@/runtime/observability";
import type {
  Envelope,
  EnvelopeToolEndStatus,
  Payload,
} from "@/runtime/ui-protocol-types";
import {
  ingest as projectionIngest,
  isProjectionV1Enabled,
  nextSeq as projectionNextSeq,
  projectionStoreKey,
} from "./projection-store";

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
  /**
   * Per-thread sequence — order within a thread.
   *
   * @deprecated M9-γ-5 (issue #842): the projection collapses identity
   * to server `seq` (`(thread_id, seq)`); per-thread ordering is implicit
   * in the envelope arrival order. Field kept on the legacy reducer's
   * `Thread`/`ThreadMessage` shape so flag-OFF code paths still compile;
   * projection-mode consumers MUST NOT depend on it.
   */
  intra_thread_seq?: number;
  meta?: MessageMeta;
  /**
   * For assistant/tool messages: parent thread root cmid.
   *
   * @deprecated M9-γ-5 (issue #842): under projection_v1, `client_message_id`
   * lives ONLY on `user_message` envelopes (per the locked rule from γ-1
   * round-2); thread membership is derived from `(thread_id, seq)`. Field
   * kept on the legacy reducer's `Thread`/`ThreadMessage` shape so flag-OFF
   * code paths still compile; projection-mode consumers MUST NOT depend
   * on it.
   */
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

/**
 * M10 Phase 6.2 (Bug C): per-session WS `session/hydrate` snapshot
 * cached so that subsequent `replayHistory` calls (the forced retries
 * in chat-thread.tsx fire at 2s/5s/12s) can replay the dedup pass on
 * the freshly-replayed thread state. Without this, the second retry
 * would undo the dedup we applied after the first replay.
 *
 * Keyed by `storeKey(sessionId, topic)`. Populated by the bridge's
 * post-`session/open` hydrate call (see `ui-protocol-runtime.ts`).
 * Cleared by `clearSession`.
 */
// `HydrateSnapshot` (defined alongside `applyHydrateDedup` below) is
// the authoritative shape; this Parameters lookup keeps the cache
// value tied to whatever the dedup pass accepts so it stays in sync
// if the function's signature widens further.
const hydrateSnapshotByKey = new Map<
  string,
  Parameters<typeof applyHydrateDedup>[2]
>();

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

/** Find the storeKey hosting the given thread. Used by the projection-mode
 *  shim: legacy entry points like `appendAssistantToken` carry a
 *  threadId without (sessionId, topic), so the shim walks
 *  `sessionsByKey` to find the bucket — same lookup as `findThreadById`
 *  but returning the key string for `projectionIngest()`. Returns null
 *  when the thread is not yet hosted (caller should skip the dual-write
 *  rather than silently invent a bucket). */
function findStoreKeyForThread(threadId: string): string | null {
  for (const [key, state] of sessionsByKey.entries()) {
    if (state.byId.has(threadId)) return key;
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
// Projection-mode shim (M9-γ-3, issue #840)
//
// When the `octos_projection_v1` localStorage flag is `"1"`, every
// legacy mutation entry point ALSO synthesizes an `Envelope` and
// ingests it into the projection store (`./projection-store.ts`). The
// legacy reducer continues to run unchanged so `getThreads()` keeps
// returning the same `Thread[]` shape — that's why the existing 191
// tests pass under both flag states. The projection log accumulates in
// parallel; new projection-only tests assert against
// `getProjection()`.
//
// Seq synthesis: per-(storeKey, threadId) monotonic counter inside
// `projection-store`. Deterministic, NOT `Date.now()` — when γ-5 stops
// using the legacy reducer, the projection re-projects the same log
// and produces a byte-identical view.
// ---------------------------------------------------------------------------

/** Resolve the storeKey for a thread when only the threadId is in
 *  hand. Walks live sessions; returns null when the thread has not yet
 *  been routed (e.g. the very first call before `addUserMessage`). The
 *  shim uses this to skip translating envelopes for un-routed threads —
 *  no information is lost; the projection just doesn't see the event,
 *  same as if the legacy reducer dropped it as orphan-without-host. */
function shimResolveKey(threadId: string): string | null {
  return findStoreKeyForThread(threadId);
}

/** Pending `client_message_id` SET per storeKey. Set when
 *  `addUserMessage` opens a thread; consumed (cleared) on the FIRST
 *  envelope emitted for that thread so the cmid lands exactly once on
 *  the wire. The projection captures the cmid into its `UserView` from
 *  the first envelope it sees for a given thread.
 *
 *  M9-γ-5 (issue #842): the prior implementation keyed cmids by
 *  threadId — but for a fresh user-rooted thread the threadId IS the
 *  cmid (callers in `sse-bridge` and `ui-protocol-send` pass the same
 *  string for both). The projection re-derives thread membership from
 *  `(thread_id, seq)` ordering, so the threadId-keyed inner map is
 *  redundant. A flat `Set<cmid>` per storeKey is the minimal carrier:
 *  on shim ingest, if `threadId` is in the set we attach + remove. */
const pendingClientMessageIds = new Map<string, Set<string>>();

function setPendingClientMessageId(
  storeKey: string,
  cmid: string,
): void {
  let perKey = pendingClientMessageIds.get(storeKey);
  if (!perKey) {
    perKey = new Set();
    pendingClientMessageIds.set(storeKey, perKey);
  }
  perKey.add(cmid);
}

function consumePendingClientMessageId(
  storeKey: string,
  threadId: string,
): string | undefined {
  // For fresh user-rooted threads, `threadId === cmid`. Look up the
  // threadId in the set; if present, that IS the cmid.
  const perKey = pendingClientMessageIds.get(storeKey);
  if (!perKey || !perKey.has(threadId)) return undefined;
  perKey.delete(threadId);
  return threadId;
}

/** Translate-and-ingest helper for the dual-write path. Handles the
 *  pending-cmid handoff so a thread's first envelope carries the
 *  client_message_id without callers having to thread it through every
 *  shim site explicitly. */
function shimIngest(
  storeKey: string,
  threadId: string,
  payload: Payload,
  options: { client_message_id?: string; seq?: number } = {},
): void {
  const seq = options.seq ?? projectionNextSeq(storeKey, threadId);
  const cmid =
    options.client_message_id !== undefined
      ? options.client_message_id
      : consumePendingClientMessageId(storeKey, threadId);
  const envelope: Envelope = {
    thread_id: threadId,
    seq,
    payload,
    ...(cmid !== undefined ? { client_message_id: cmid } : {}),
  };
  projectionIngest(storeKey, envelope);
}

/** Map a legacy `ThreadToolCall.status` (which carries `"running"` for
 *  in-flight calls) to the projection's `tool_end` status enum
 *  (`"complete" | "error"`). The projection has no concept of a
 *  running/in-flight tool — `tool_start` opens, `tool_end` closes.
 *  `"running"` is a no-op signal that does not warrant a `tool_end`
 *  envelope; the shim returns null and the caller skips emission. */
function shimMapToolEndStatus(
  status: "running" | "complete" | "error",
): EnvelopeToolEndStatus | null {
  if (status === "complete") return "complete";
  if (status === "error") return "error";
  return null;
}

// ---------------------------------------------------------------------------
// Public API — mutators
// ---------------------------------------------------------------------------

/**
 * M9-γ-4: Register a pending `client_message_id` WITHOUT mutating the
 * legacy reducer. Used by the `<GhostBubble>` overlay so the very first
 * dual-write envelope on this thread (e.g. an `assistant_delta` from
 * the server's reflected response) carries the cmid — which the
 * projection captures into `UserView.client_message_id` and the
 * GhostBubble matches on to settle.
 *
 * The legacy reducer is intentionally untouched: under projection_v1,
 * the optimistic user bubble is a pure visual overlay; the durable user
 * row only enters `getThreads()` if/when an orphan thread is opened by
 * a later assistant token (`appendAssistantToken` calls
 * `ensureOrphanThread`). This guarantees the acceptance criterion:
 * "ThreadStore must NOT have a `<GhostBubble>` row when flag ON."
 *
 * M9-γ-5 (issue #842): the redundant `threadId` parameter is gone. The
 * threadId IS the cmid for fresh user-rooted threads, and the projection
 * re-derives thread membership from `(thread_id, seq)` — there is
 * nothing additional to bucket the cmid by.
 */
export function registerPendingClientMessageId(
  sessionId: string,
  clientMessageId: string,
  topic?: string,
): void {
  const key = storeKey(sessionId, topic);
  setPendingClientMessageId(key, clientMessageId);
}

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
  // double-inserting. Three flavours:
  //  • Orphan bucket with no responses yet — created earlier by a late
  //    background event whose user message hadn't been added yet.
  //    Preserve its in-flight `pendingAssistant`; if none, open a fresh
  //    pending so the upcoming stream events have a slot to land in.
  //  • In-flight thread (pending non-null) — keep the live pending,
  //    don't disturb runtime progress (codex review #2).
  //  • ALREADY-FINALIZED thread (pending null AND responses contain an
  //    assistant) — DO NOT spawn a fresh streaming pending. The thread
  //    has already been answered; this is a re-mirror / replay /
  //    cross-transport double-publish (mini1 2026-05-08: WS path
  //    finalises Q1 cleanly, then a late legacy-mirror or retry calls
  //    `addUserMessage` for the same cmid; pre-fix this minted a
  //    streaming pending that pinned `isRunning=true` and surfaced as
  //    the empty timestamp-only ghost bubble in the DOM). A real
  //    follow-up turn always has a fresh `clientMessageId` and roots
  //    its own thread.
  const existing = state.byId.get(opts.clientMessageId);
  if (existing) {
    existing.userMsg = userMsg;
    if (!existing.pendingAssistant) {
      const alreadyAnswered = existing.responses.some(
        (r) => r.role === "assistant",
      );
      if (!alreadyAnswered) {
        existing.pendingAssistant = pendingAssistant;
      }
    }
    notify();
    return {
      threadId: opts.clientMessageId,
      pendingAssistantId:
        existing.pendingAssistant?.id ?? pendingAssistant.id,
    };
  }

  // Adopt any orphan thread bucket that was created earlier (a late
  // background event arrived ahead of the user message) — even if it
  // landed in a different session's state. Carry over its responses
  // and in-flight pending so the runtime progress isn't dropped. Same
  // already-answered guard as the same-session branch above: if the
  // orphan already carries a finalized assistant response, do NOT
  // mint a fresh streaming pending — that would surface as the
  // phantom empty bubble.
  for (const otherState of sessionsByKey.values()) {
    if (otherState === state) continue;
    const orphan = otherState.byId.get(opts.clientMessageId);
    if (!orphan) continue;
    const orphanAlreadyAnswered =
      !orphan.pendingAssistant &&
      orphan.responses.some((r) => r.role === "assistant");
    const adopted: Thread = {
      id: opts.clientMessageId,
      userMsg,
      responses: orphan.responses,
      pendingAssistant: orphanAlreadyAnswered
        ? null
        : (orphan.pendingAssistant ?? pendingAssistant),
    };
    // Detach from the wrong session.
    otherState.byId.delete(opts.clientMessageId);
    const idx = otherState.threads.indexOf(orphan);
    if (idx !== -1) otherState.threads.splice(idx, 1);
    insertThreadInTimestampOrder(state, adopted);
    notify();
    return {
      threadId: adopted.id,
      pendingAssistantId: adopted.pendingAssistant?.id ?? pendingAssistant.id,
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

  // M9-γ-3 dual-write: a fresh user message roots the thread. The
  // projection has no `user_message` payload variant — user identity
  // is captured implicitly from the FIRST envelope that names a given
  // `thread_id` (per γ-2 `projection.ts` § "Capture user identity").
  // We register the cmid in the pending-cmid map so the next envelope
  // for this thread carries `client_message_id` on the wire — that's
  // what γ-4's GhostBubble overlay matches against.
  if (isProjectionV1Enabled()) {
    setPendingClientMessageId(key, opts.clientMessageId);
  }

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

  // M9-γ-3 dual-write: streamed token → assistant_delta envelope.
  if (isProjectionV1Enabled()) {
    const key = shimResolveKey(threadId);
    if (key) {
      shimIngest(key, threadId, {
        type: "assistant_delta",
        data: { text: token },
      });
    }
  }
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

  // M9-γ-3 dual-write: legacy `replace` semantics has no direct
  // projection counterpart (projection accumulates deltas + finalises
  // on `assistant_persisted`). Emit the full replacement text as an
  // `assistant_delta`. This is OK for the migration window: projection
  // and legacy disagree on accumulated text shape, but legacy is the
  // current truth source for `getThreads()`. γ-5 will retire the legacy
  // path entirely; by then the SSE bridge no longer emits `replace`
  // events (only deltas + persisted), so the drift goes away.
  if (isProjectionV1Enabled()) {
    const key = shimResolveKey(threadId);
    if (key) {
      shimIngest(key, threadId, {
        type: "assistant_delta",
        data: { text },
      });
    }
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

    // M9-γ-3 dual-write (codex round-1 BLOCK 2): the retry-collapse
    // path mutates legacy state in place but the wire still receives a
    // fresh `tool_start` for the NEW `tool_call_id`. The projection
    // keys tool cards on `tool_call_id`, so without this emission a
    // retry would never open a card for the new id and any subsequent
    // `tool_progress` / `tool_end` envelope would synthesise an
    // empty-name placeholder card (γ-2's "progress without a prior
    // start" path) — mismatching the legacy reducer's view.
    if (isProjectionV1Enabled() && toolCallId) {
      const key = shimResolveKey(threadId);
      if (key) {
        shimIngest(key, threadId, {
          type: "tool_start",
          data: { tool_call_id: toolCallId, name },
        });
      }
    }
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

  // M9-γ-3 dual-write: tool_start envelope. The projection requires a
  // non-empty `tool_call_id` for routing (it keys on `tool_call_id`);
  // legacy supports the empty-id fallback for legacy daemons. Skip the
  // dual-write for empty-id calls — the projection isn't responsible
  // for legacy compat, γ-5 cleanup makes the server's id mandatory.
  if (isProjectionV1Enabled() && toolCallId) {
    const key = shimResolveKey(threadId);
    if (key) {
      shimIngest(key, threadId, {
        type: "tool_start",
        data: { tool_call_id: toolCallId, name },
      });
    }
  }
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

  // M9-γ-3 dual-write: tool_progress envelope. Per the brief, the
  // projection drops late tool_progress events that arrive after a
  // `turn_completed` for the same thread (see the projection's hard
  // barrier). The shim emits unconditionally; the projection itself
  // enforces the barrier and bumps `metrics.droppedAfterTurnCompleted`.
  if (isProjectionV1Enabled() && toolCallId) {
    const key = shimResolveKey(threadId);
    if (key) {
      shimIngest(key, threadId, {
        type: "tool_progress",
        data: { tool_call_id: toolCallId, message },
      });
    }
  }
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

  // M9-γ-3 dual-write: setToolCallStatus → tool_end envelope. Skip
  // the `"running"` flavour (projection has no in-flight status —
  // tool_start opens, tool_end closes); only `"complete"` and
  // `"error"` translate to a wire-level `tool_end`.
  if (isProjectionV1Enabled() && toolCallId) {
    const endStatus = shimMapToolEndStatus(status);
    if (endStatus !== null) {
      const key = shimResolveKey(threadId);
      if (key) {
        shimIngest(key, threadId, {
          type: "tool_end",
          data: { tool_call_id: toolCallId, status: endStatus },
        });
      }
    }
  }
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
  if (!host) {
    return false;
  }
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
      if (r.text.length > 0) {
        return true;
      }
      thread.responses[i] = upgradePlaceholderRow(r, opts, threadId);
      sortResponsesInThread(thread);
      notify();
      return true;
    }
    if (thread.pendingAssistant?.id === opts.messageId) {
      return true;
    }
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
        if (rowMatchesCompletionContent(r, opts)) {
          return true;
        }
        continue; // (a): merged-ack row, not our target
      }
      thread.responses[i] = upgradePlaceholderRow(r, opts, threadId);
      sortResponsesInThread(thread);
      notify();
      return true;
    }
    if (thread.pendingAssistant?.historySeq === opts.historySeq) {
      return true;
    }
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

  // M9-γ-3 dual-write: completion bubble → assistant_persisted envelope.
  // The projection enforces text/meta finalisation here. Use the
  // server-authoritative `historySeq` as the projection seq when the
  // caller supplied one (matches the wire-level seq on a replay) so
  // late re-emissions of the same row dedup cleanly via the
  // projection's `(thread_id, seq)` idempotency.
  if (isProjectionV1Enabled()) {
    const key =
      shimResolveKey(threadId) ??
      (opts.sessionId
        ? projectionStoreKey(opts.sessionId, opts.topic)
        : null);
    if (key) {
      const messageId = opts.messageId ?? completion.id;
      shimIngest(key, threadId, {
        type: "assistant_persisted",
        data: {
          text: opts.text,
          meta: {
            message_id: messageId,
            persisted_at:
              opts.persistedAt ??
              new Date(completion.timestamp).toISOString(),
            ...(opts.media.length > 0 ? { media: opts.media.slice() } : {}),
          },
        },
      }, opts.historySeq !== undefined ? { seq: opts.historySeq } : undefined);
    }
  }

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

  // M9-γ-3 dual-write: file delivery → file_attached envelope. Legacy
  // `MessageFile` doesn't carry `mime` / `size_bytes`; use defensible
  // defaults that the projection accepts (the wire-level event always
  // carries both, this is only the migration-time shim).
  if (isProjectionV1Enabled()) {
    const key = shimResolveKey(threadId);
    if (key) {
      shimIngest(key, threadId, {
        type: "file_attached",
        data: {
          path: file.path,
          mime: "",
          size_bytes: 0,
        },
      });
    }
  }

  return true;
}

/**
 * M10 Phase 5b: stamp the per-thread server seq onto the in-flight
 * `pendingAssistant` without finalising it. Used by the v1 router's
 * empty-placeholder defence: when an assistant `message/persisted`
 * event arrives BEFORE the streamed `message/delta`, we acknowledge
 * the seq (so a later finalise without a seq from `turn/completed`
 * still picks up the durable identity) but leave the bubble in its
 * `pendingAssistant` slot so subsequent deltas can land in it.
 *
 * No-op when there's no pending bubble in `threadId`. Idempotent:
 * stamping the same seq twice is safe.
 */
export function stampPendingHistorySeq(
  threadId: string,
  historySeq: number,
): void {
  const found = findThreadById(threadId);
  if (!found || !found.thread.pendingAssistant) return;
  if (found.thread.pendingAssistant.historySeq === historySeq) return;
  found.thread.pendingAssistant = {
    ...found.thread.pendingAssistant,
    historySeq,
    intra_thread_seq:
      found.thread.pendingAssistant.intra_thread_seq ?? historySeq,
  };
  notify();

  // M9-γ-3 dual-write: stamp-only operation has no projection
  // counterpart. The projection finalises bubbles on
  // `assistant_persisted` (which carries `meta.message_id` +
  // `persisted_at`); a bare seq-stamp without text/meta is purely a
  // legacy bookkeeping fix the v1 router needs to acknowledge a
  // `message/persisted` that arrived BEFORE its `message/delta`.
  // Intentionally no envelope emission here.
  //
  // Why this no-op is safe under the projection: the `historySeq`
  // stamp is purely a legacy reducer detail. The projection's gap-
  // buffer applies envelopes in canonical `(thread_id, seq)` order on
  // arrival; the eventual `assistant_persisted` / `turn_completed`
  // envelope is what finalises the bubble. A bare stamp without
  // text/meta carries no projection-relevant payload, so we elide it.
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
/**
 * Stamp `meta` (and optionally `status`) onto the most recent
 * *assistant* response for `threadId`. Used by the UI Protocol event
 * router (`handleTurnCompleted` / `handleTurnError`) when an earlier
 * `message/persisted` already promoted the pending bubble — by the
 * time `turn/completed` lands, `pendingAssistant` is null and
 * `finalizeAssistant`'s pending-required guard would otherwise drop the
 * accumulated per-turn cost snapshot on the floor. Codex P2 fix.
 *
 * Codex round-3 P2: we search BACKWARDS for the most recent `assistant`
 * row rather than blindly patching the tail. A media-only companion
 * row or a tool result appended AFTER the assistant promotion would
 * otherwise capture the meta+status, leaving the visible answer
 * blank. Tool rows (`role === "tool"`) aren't visible bubbles, and
 * media-only companions render as part of the assistant they're
 * attached to — but their `status` / `meta` are read by other parts
 * of the renderer; we want the stamp to land on the actual text
 * answer.
 *
 * No-ops when:
 *   - no thread matches `threadId` in any session,
 *   - the thread has no assistant responses yet (the snapshot is just
 *     lost, same as before this helper existed; `handleTurnCompleted`
 *     fall back to `finalizeAssistant` for the pending-present case).
 */
export function patchLastResponseMeta(
  threadId: string,
  opts: { meta?: MessageMeta; status?: ThreadMessage["status"] },
): void {
  for (const state of sessionsByKey.values()) {
    const thread = state.byId.get(threadId);
    if (!thread || thread.responses.length === 0) continue;
    // Walk responses tail-to-head looking for the most recent assistant
    // row. Tool rows + media-only companions are skipped — they're
    // either folded into the preceding assistant bubble at render time
    // or filtered out entirely (`isVisibleResponse` drops tool rows).
    let idx = -1;
    for (let i = thread.responses.length - 1; i >= 0; i--) {
      if (thread.responses[i].role === "assistant") {
        idx = i;
        break;
      }
    }
    if (idx === -1) continue;
    const last = thread.responses[idx];
    const next: ThreadMessage = {
      ...last,
      meta: opts.meta ?? last.meta,
      status: opts.status ?? last.status,
    };
    thread.responses[idx] = next;
    notify();
    return;
  }
}

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
    // Also remember which ids were swept so the projection dual-write
    // below can emit synthetic `tool_end` envelopes for them BEFORE
    // `turn_completed` (codex round-1 BLOCK 3).
    const sweptToolCallIds: string[] = [];
    const sweptToolCalls = thread.pendingAssistant.toolCalls.map((tc) => {
      if (tc.status === "running") {
        if (tc.id) sweptToolCallIds.push(tc.id);
        return { ...tc, status: "complete" as const };
      }
      return tc;
    });

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

    // M9-γ-3 dual-write: finalize → turn_completed envelope (the
    // projection's hard barrier). Maps token usage best-effort from
    // the legacy `meta` (which carries `tokens_in` / `tokens_out` —
    // we mirror them onto the projection's `input_tokens` /
    // `output_tokens`). The barrier is what the brief's projection-
    // only test "Late `tool_progress` after `turn_completed`"
    // exercises.
    if (isProjectionV1Enabled()) {
      const key = shimResolveKey(threadId);
      if (key) {
        // codex round-1 BLOCK 3: emit a synthetic `tool_end` for every
        // tool call that legacy `finalizeAssistant` swept from
        // `running` → `complete` (the wire never delivered an explicit
        // tool_end). MUST happen BEFORE `turn_completed` since the
        // projection's hard barrier drops anything after a thread is
        // marked complete — a late tool_end on the wire would never
        // reach the projection's tool card. Empty-id calls (legacy
        // daemon path) are skipped at sweep-collection time.
        for (const sweptId of sweptToolCallIds) {
          shimIngest(key, threadId, {
            type: "tool_end",
            data: { tool_call_id: sweptId, status: "complete" },
          });
        }

        const meta = opts.meta ?? finalized.meta;
        const usage =
          meta !== undefined
            ? {
                ...(meta.tokens_in
                  ? { input_tokens: meta.tokens_in }
                  : {}),
                ...(meta.tokens_out
                  ? { output_tokens: meta.tokens_out }
                  : {}),
              }
            : {};
        shimIngest(key, threadId, {
          type: "turn_completed",
          data: { token_usage: usage },
        });
      }
    }

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

  // M10 Phase 6.2 (Bug C): if the bridge already hydrated, apply its
  // dedup pass against the freshly-replayed thread state. The forced
  // retries in chat-thread.tsx mean `replayHistory` fires multiple
  // times on a reload; we re-apply each time to keep the post-refresh
  // DOM convergent with the live wire's suppressed-row shape.
  //
  // We always `notify()` first so subscribers see the freshly-replayed
  // history even if `applyHydrateDedup` short-circuits (e.g. cached
  // snapshot from an older server has no `replayed_envelopes`).
  notify();
  const cachedHydrate = hydrateSnapshotByKey.get(key);
  if (cachedHydrate) {
    applyHydrateDedup(sessionId, topic, cachedHydrate);
  }
}

/**
 * M10 Phase 6.2 (Bug C) + M10.5 reload-mid-stream fix: cache the WS
 * `session/hydrate` result so that subsequent `replayHistory` calls
 * (the forced retries in chat-thread.tsx) re-run the dedup pass
 * against the freshly-replayed thread state. Triggers an immediate
 * dedup pass on the current state so a hydrate that lands AFTER the
 * first `replayHistory` still cleans up the duplicate rows.
 *
 * M10.5: also runs `applyHydrateDedup` when the store is empty for
 * this scope (no thread state yet). The dedup function's own
 * `seedFromHydrateMessages` will populate the store from
 * `hydrate.messages` when REST returned `[]`. Without this branch the
 * SPA produced an orphan completion bubble whenever REST and WS
 * disagreed about whether the session had any history.
 */
export function setHydrateSnapshot(
  sessionId: string,
  topic: string | undefined,
  hydrate: HydrateSnapshot,
): void {
  const key = storeKey(sessionId, topic);
  hydrateSnapshotByKey.set(key, hydrate);
  // Always invoke the dedup pass:
  //   • If the store already has thread state for this scope, dedup
  //     coalesces the legacy spawn-ack rows behind retained envelopes
  //     (Bug C).
  //   • If the store is empty for this scope, the dedup pass's
  //     `seedFromHydrateMessages` step populates it from
  //     `hydrate.messages` so the user prompt + narration row are
  //     visible (M10.5 reload-mid-stream fallback).
  applyHydrateDedup(sessionId, topic, hydrate);
}

/**
 * `HydratedMessage` shape `applyHydrateDedup` and `seedFromHydrateMessages`
 * accept. Mirrors `octos_core::ui_protocol::HydratedMessage` (cf.
 * `runtime/ui-protocol-types.ts`).
 *
 * The dedup pass below only reads the metadata fields (seq, message_id,
 * source, thread_id, turn_id, media). The seed pass additionally reads
 * `role`, `content`, `client_message_id`, and `persisted_at` so it can
 * reconstruct the full `Thread` shape when REST `loadHistory` returned
 * `[]` (M10.5 reload-mid-stream fallback).
 *
 * Both extra fields are optional on the wire — older servers omit them.
 * When absent, the seed pass treats the row the same way the legacy REST
 * `replayHistory` treats a `MessageInfo` with the same gaps: skip
 * unknown roles, default the content to empty string, etc.
 */
export interface HydrateMessageRow {
  seq: number;
  message_id?: string;
  source?: string;
  thread_id?: string;
  turn_id?: string;
  media?: string[];
  /** Wire role: `user | assistant | tool | system`. Absent on older
   *  servers; treat as `assistant` so the row is at least visible. */
  role?: string;
  /** Verbatim text from the canonical session JSONL. */
  content?: string;
  /** Stable per-row client id. The seed pass uses this to root user
   *  messages on the same `client_message_id` REST would have used. */
  client_message_id?: string;
  /** ISO-8601 persistence timestamp. Used for `Thread` ordering. */
  persisted_at?: string;
}

export interface HydrateEnvelope {
  thread_id?: string;
  turn_id?: string;
  response_to_client_message_id?: string;
  task_id: string;
  seq: number;
  message_id: string;
  content: string;
  media?: string[];
  persisted_at: string;
}

export interface HydrateSnapshot {
  messages?: HydrateMessageRow[];
  replayed_envelopes?: HydrateEnvelope[];
}

/**
 * Convert a [`HydrateMessageRow`] (the WS `session/hydrate` shape) into
 * a [`MessageInfo`] (the REST `/messages` shape) so the existing
 * `replayHistory` logic can ingest it without reimplementing the whole
 * adjacent-merge / orphan-thread / dedup pipeline. Skips rows that lack
 * the minimum (`role` + `content`) needed to reconstruct a chat bubble.
 */
function hydrateRowToMessageInfo(row: HydrateMessageRow): MessageInfo | null {
  if (!row.role || row.content === undefined) return null;
  if (
    row.role !== "user" &&
    row.role !== "assistant" &&
    row.role !== "tool" &&
    row.role !== "system"
  ) {
    return null;
  }
  const timestamp =
    typeof row.persisted_at === "string" && row.persisted_at.length > 0
      ? row.persisted_at
      : new Date().toISOString();
  return {
    seq: row.seq,
    role: row.role,
    content: row.content,
    client_message_id: row.client_message_id,
    thread_id: row.thread_id,
    timestamp,
    media: row.media,
  };
}

/**
 * M10.5 reload-mid-stream fallback: when REST `loadHistory` returned no
 * rows (server-side bug or just race) but the WS `session/hydrate`
 * carried `messages[]`, seed the store from those rows BEFORE
 * `applyHydrateDedup` runs. Without this, the SPA renders only the
 * envelope's completion bubble — with no user prompt or narration row
 * to anchor it — producing the orphan-completion shape the M10
 * hardening test catches.
 *
 * Idempotency: a subsequent `replayHistory` call (REST retries fire at
 * 2s/5s/12s) replaces state wholesale, so a real REST response that
 * lands later wins for any overlap with the hydrate seed. A second
 * hydrate snapshot for an already-seeded session is a no-op (state is
 * not empty).
 *
 * Returns `true` when seeding actually populated the store — callers
 * can use this to decide whether `applyHydrateDedup`'s envelope-emit
 * pass needs the now-existing thread state for placeholder upgrades.
 */
/**
 * Returns `true` when every thread in `state` is an orphan-placeholder
 * — created by `appendCompletionBubble` for an envelope whose hydrate
 * snapshot has not yet landed. Such a thread has an empty user-bubble
 * (no text, no files) and is safe to replace with the canonical
 * hydrate seed, which carries the real prompt + narration rows.
 *
 * Codex SPA round 1 P2.2: an envelope-before-hydrate ordering puts a
 * placeholder thread in the store BEFORE `setHydrateSnapshot` runs.
 * Without this predicate the seed pass would treat the placeholder as
 * authoritative state and skip seeding, leaving the orphan-completion
 * shape this fix exists to prevent.
 */
function allThreadsAreOrphanPlaceholders(state: SessionState): boolean {
  if (state.threads.length === 0) return true;
  for (const t of state.threads) {
    if (t.userMsg.text.length > 0) return false;
    if (t.userMsg.files.length > 0) return false;
  }
  return true;
}

/**
 * M10.5 reload-mid-stream regression fix: predicate matching the
 * `applyHydrateDedup` envelope-coverage contract for a single hydrate
 * row. A row is "covered" when:
 *
 *   - `source === "background"` (the legacy companion marker the live
 *     wire suppresses for negotiated clients), AND either
 *
 *     (a) `message_id` matches some envelope's `message_id` — the
 *         spawn-ack the envelope replaces; OR
 *     (b) `media` is non-empty AND every path is in some envelope's
 *         `media` set, with anchor (`thread_id`) match required and
 *         `turn_id` agreement when both sides expose it (codex
 *         round-6 P2 on the dedup loop applies here too).
 *
 * Use cases:
 *   • `seedFromHydrateMessages` filters covered rows BEFORE feeding
 *     `replayHistory` so the seed step never produces a sibling
 *     bubble for the legacy companion. Without this, the dedup loop
 *     downstream still drops the row but only if its `historySeq`
 *     survives `replayHistory`'s adjacent-merge intact — and any
 *     companion that the live wire emits AFTER the hydrate seed (via
 *     `message/persisted` for a long-running spawn_only completion)
 *     would still produce a duplicate bubble. Filtering at the seed
 *     contract level prevents both classes.
 *
 *   • `applyHydrateDedup`'s downstream loop continues to apply the
 *     same predicate to the post-seed thread state for any row that
 *     somehow survived (e.g. cached snapshot re-applied after a REST
 *     replay reseeded the store).
 *
 * Defensive: rows whose `source` is not `"background"` and rows whose
 * coverage cannot be proven (no message_id match AND no anchor for
 * the media-subset check) are NOT covered. We only delete on positive
 * evidence — a duplicate render is recoverable; an erased row is not.
 */
function hydrateRowCoveredByEnvelope(
  row: HydrateMessageRow,
  envelopes: HydrateEnvelope[],
): boolean {
  if (envelopes.length === 0) return false;
  if (row.source !== "background") return false;

  // (a) message_id match — session-unique, works without thread_id.
  if (row.message_id) {
    for (const e of envelopes) {
      if (e.message_id === row.message_id) return true;
    }
  }

  // (b) anchor + media-subset match. Anchor required so a different
  // completion in a different thread that happens to reuse a media
  // path is never wrongly covered. When both sides expose `turn_id`
  // they must agree (codex round-6 P2 on the dedup loop); when either
  // side omits it we fall back to anchor+media match (current server
  // emits `turn_id: None` on `MessagePersistedEvent`s).
  const anchor = row.thread_id;
  if (!anchor) return false;
  if (!row.media || row.media.length === 0) return false;
  for (const e of envelopes) {
    const envAnchor = e.thread_id ?? e.response_to_client_message_id ?? null;
    if (envAnchor !== anchor) continue;
    if (row.turn_id && e.turn_id && row.turn_id !== e.turn_id) continue;
    const envMedia = new Set(e.media ?? []);
    if (envMedia.size === 0) continue;
    if (row.media.every((p) => envMedia.has(p))) return true;
  }
  return false;
}

function seedFromHydrateMessages(
  sessionId: string,
  topic: string | undefined,
  rows: HydrateMessageRow[],
  envelopes: HydrateEnvelope[],
): boolean {
  if (rows.length === 0) return false;
  const key = storeKey(sessionId, topic);
  const existing = sessionsByKey.get(key);
  // REST result wins for any overlap — only seed when state is empty
  // OR when the only existing threads are orphan placeholders created
  // by an envelope that landed before the hydrate response (codex SPA
  // round 1 P2.2).
  //
  // This means: on a healthy REST response we never touch the seeded
  // shape; on a `[]` REST response (the bug we're fixing) the seed
  // remains visible until the next REST retry — which post-PR-1
  // server fix is itself non-empty; on an envelope-before-hydrate
  // ordering, the placeholder thread is replaced by the canonical
  // hydrate history.
  if (existing && !allThreadsAreOrphanPlaceholders(existing)) {
    return false;
  }

  const apiMessages: MessageInfo[] = [];
  let hasUserRow = false;
  for (const row of rows) {
    // M10.5 reload-mid-stream regression: skip rows the envelope
    // contract already covers, BEFORE feeding `replayHistory`. If we
    // let a covered `Background`-source row through, `replayHistory`
    // may fold it into a sibling bubble via `mergeMediaCompanionInto`
    // (donating its `historySeq`) and then `appendCompletionBubble`
    // appends the envelope as a SEPARATE bubble — yielding the
    // 1 user + 3 assistant shape `m10-harden-reload-midstream` catches.
    // Drop the row at the seed contract; the envelope-emit pass then
    // produces exactly 1 completion bubble downstream.
    if (hydrateRowCoveredByEnvelope(row, envelopes)) continue;
    const info = hydrateRowToMessageInfo(row);
    if (!info) continue;
    // Codex SPA round 1 P2.1: `replayHistory` skips `system` rows.
    // If we feed a system-only batch through, `replayHistory` writes
    // empty state, then re-invokes `applyHydrateDedup` (via its
    // cached-hydrate dedup re-application at the end), which calls
    // `seedFromHydrateMessages` again on the still-empty store —
    // infinite recursion until the call stack overflows.
    //
    // Filter system rows here so the seedable count reflects what
    // `replayHistory` will actually persist.
    if (info.role === "system") continue;
    apiMessages.push(info);
    if (info.role === "user") hasUserRow = true;
  }
  if (apiMessages.length === 0) return false;
  // Codex SPA round 2 P2: a hydrate with non-system but assistant/
  // tool-only rows produces a `replayHistory` output that has only
  // orphan-placeholder threads (empty user bubbles) — exactly the
  // shape `allThreadsAreOrphanPlaceholders` greenlights for re-
  // seeding. The cached-hydrate hook at the end of `replayHistory`
  // would then call `applyHydrateDedup` again, which re-enters this
  // function and recurses forever.
  //
  // Require at least one user row before seeding. A user-less hydrate
  // is not a useful seed anyway: the canonical reload-mid-stream
  // shape this fallback exists for ALWAYS carries the user prompt
  // (it lives in the same JSONL the assistant rows do).
  if (!hasUserRow) return false;
  // Reuse `replayHistory`'s adjacent-merge + orphan-thread synthesis.
  // It replaces state for `key` wholesale; an orphan-placeholder
  // existing state is intentionally clobbered by the seed (P2.2).
  replayHistory(sessionId, apiMessages, topic);
  return true;
}

/**
 * M10 Phase 6.2 (Bug C): apply the WS `session/hydrate` dedup pass on
 * top of an already-hydrated thread state. Server PR #791 surfaces
 * three new fields on `session/hydrate` for connections that
 * negotiated `event.spawn_complete.v1`:
 *
 *   - `messages[i].message_id`  — stable per-row identity
 *   - `messages[i].source`      — wire-form `MessagePersistedSource`
 *   - `replayed_envelopes[]`    — retained `turn/spawn_complete` events
 *
 * The legacy REST `loadHistory` path returns the FULL ledger including
 * the per-file companion + spawn-ack rows that the live wire suppresses
 * for negotiated clients (server side rounds-3..6 of PR #791 deemed
 * server-side suppression intractable; the negotiated dedup contract
 * lives on the client). Without this pass, a page reload renders N+1
 * assistant bubbles where the live page rendered N.
 *
 * M10.5 reload-mid-stream addition: if `hydrate.messages` is non-empty
 * AND the store has no thread state for this scope, seed it from those
 * rows (via `seedFromHydrateMessages`) BEFORE the dedup pass. Without
 * this, an empty REST `loadHistory` response leaves the dedup pass
 * with no rows to coalesce and `appendCompletionBubble` produces an
 * orphan completion (the bug
 * `tests/m10-harden-reload-midstream.spec.ts` catches).
 *
 * Algorithm (per server PR #791 docstring on `replayed_envelopes`):
 *
 *   1. Index envelopes by `message_id` (the spawn-ack's id) and by the
 *      anchor `thread_id` (placement key).
 *   2. Build a `seq → HydratedMessage` map over the hydrated rows so we
 *      can look up `(message_id, source)` for each thread response by
 *      its `historySeq`.
 *   3. For each thread, walk responses and drop those whose hydrated
 *      counterpart has `source === "background"` AND either:
 *        (a) `message_id` matches an envelope's `message_id` — the
 *            spawn-ack the envelope replaces; or
 *        (b) it sits in the same anchor thread as an envelope and
 *            has an earlier or equal `seq` than that envelope — a
 *            per-file companion the envelope's `media` already
 *            covers.
 *   4. For each envelope, call `appendCompletionBubble` (idempotent via
 *      its existing `messageId` dedup, so a live-wire envelope already
 *      placed for the same row is a no-op).
 *
 * Best-effort: rows missing `historySeq`, hydrated rows whose
 * `message_id` / `source` are absent (older server, or non-negotiated
 * connection), or envelopes without an anchor thread are skipped — we
 * never delete a row we can't prove is the legacy duplicate.
 */
export function applyHydrateDedup(
  sessionId: string,
  topic: string | undefined,
  hydrate: HydrateSnapshot,
): void {
  const envelopes = hydrate.replayed_envelopes ?? [];
  const messages = hydrate.messages ?? [];
  // M10.5 reload-mid-stream fallback: if REST hasn't seeded the store
  // yet (it returned `[]` or hasn't fired) but WS hydrate carried the
  // full message list, seed from hydrate first so the dedup pass below
  // and the envelope-emit have a thread to anchor to. Pass `envelopes`
  // through so the seed step drops `Background`-source companion rows
  // covered by an envelope BEFORE `replayHistory`'s adjacent-merge can
  // fold their `historySeq` onto a sibling bubble — the bug
  // `m10-harden-reload-midstream` catches when both the legacy
  // companion AND the envelope land in the same hydrate response.
  seedFromHydrateMessages(sessionId, topic, messages, envelopes);
  if (envelopes.length === 0) return;

  // Build the seq → row metadata index, including media so we can
  // identify per-file companion rows by media-subset against an
  // envelope's coalesced media list.
  const rowBySeq = new Map<
    number,
    {
      message_id?: string;
      source?: string;
      thread_id?: string;
      media?: string[];
    }
  >();
  for (const m of messages) {
    rowBySeq.set(m.seq, {
      message_id: m.message_id,
      source: m.source,
      thread_id: m.thread_id,
      media: m.media,
    });
  }

  // Per-envelope dedup. Per server PR #791 docstring: an envelope
  // coalesces (a) the spawn-ack row by `message_id` match, (b)
  // per-file `send_file` companion rows whose `media` paths are a
  // subset of the envelope's `media` array. We index each envelope
  // independently so a row's media-subset match is bounded to the
  // SPECIFIC envelope whose media it covers — not the union of all
  // envelopes in the same anchor thread (codex round-5 P2: that
  // union would wrongly cover an unrelated row whose envelope aged
  // out of the retention window but whose media path happened to
  // appear in another retained envelope).
  //
  // A background-source row is covered by an envelope `e` when:
  //   (a) `m.message_id === e.message_id` (the spawn-ack match), OR
  //   (b) `m.thread_id` matches `e`'s anchor, `m.media` is non-empty,
  //       AND every path in `m.media` is in `e.media` (the per-file
  //       companion match — bounded to a single envelope).
  // Companions not matching ANY envelope are preserved (a duplicate
  // render is recoverable; an erased row is not).
  const allEnvelopeMessageIds = new Set<string>();
  for (const e of envelopes) allEnvelopeMessageIds.add(e.message_id);

  // Pre-compute each envelope's media set (frozen) for the per-row
  // subset check below. Carries `turn_id` so the match can be bounded
  // to the same turn when both sides expose it (codex round-6 P2:
  // a thread with two background completions emitting the same media
  // path must NOT cross-pollinate through anchor+media alone).
  const envelopeMediaSets: Array<{
    anchor: string | null;
    turn_id: string | null;
    media: Set<string>;
  }> = envelopes.map((e) => ({
    anchor: e.thread_id ?? e.response_to_client_message_id ?? null,
    turn_id: e.turn_id ?? null,
    media: new Set(e.media ?? []),
  }));

  // Collect per-anchor "covered by media-subset" seqs AND a separate
  // session-wide "covered by message_id" seq set (for the
  // no-thread-id fallback).
  const coveredSeqsByAnchor = new Map<string, Set<number>>();
  const coveredSeqsByMessageId = new Set<number>();
  for (const m of messages) {
    if (m.source !== "background") continue;

    // (a) message_id match — session-unique, works without thread_id.
    if (m.message_id && allEnvelopeMessageIds.has(m.message_id)) {
      coveredSeqsByMessageId.add(m.seq);
      // Continue to (b) for completeness — a row covered by both
      // routes is still covered exactly once below.
    }

    // (b) per-envelope media-subset match. Anchor required (a
    // different completion in a different thread may reuse the same
    // path; we never cross thread boundaries on media match). When
    // both sides expose a `turn_id`, they must agree (codex round-6
    // P2: two completions in the same thread that share a media path
    // must NOT bleed across each other on media-subset alone).
    //
    // When either side omits `turn_id` we fall back to anchor+media
    // match. The current server (PR #791 era) emits `turn_id: None`
    // for `MessagePersistedEvent`s and does not stamp it on hydrated
    // rows for spawn_only completions — applying a strict turn_id
    // requirement would disable the Bug C fix entirely for live
    // production traffic. The residual theoretical risk (codex
    // round-8 P2: two background completions under the same prompt
    // emit the SAME exact media path) is negligible in practice
    // because spawn_only artefact paths embed UUIDv7s, so
    // cross-completion path collisions don't occur. Once the server
    // typed-id work propagates `turn_id` onto Message rows, this
    // fallback can become a hard equality check.
    const anchor = m.thread_id;
    if (!anchor) continue;
    if (!m.media || m.media.length === 0) continue;
    let matched = false;
    for (const env of envelopeMediaSets) {
      if (env.anchor !== anchor) continue;
      if (m.turn_id && env.turn_id && m.turn_id !== env.turn_id) {
        continue;
      }
      // Bound the subset check to a SINGLE envelope's media so a
      // companion only counts as covered when there's a specific
      // envelope it pairs with.
      if (m.media.every((p) => env.media.has(p))) {
        matched = true;
        break;
      }
    }
    if (matched) {
      let bag = coveredSeqsByAnchor.get(anchor);
      if (!bag) {
        bag = new Set<number>();
        coveredSeqsByAnchor.set(anchor, bag);
      }
      bag.add(m.seq);
    }
  }

  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) {
    // No thread state to dedup — emit envelopes as fresh bubbles below.
  } else {
    // For each thread, drop responses whose `historySeq` is covered
    // either by an anchor's media-subset match OR by a session-wide
    // message_id match (no thread_id required for the latter — codex
    // round-4 P2). Handles both the post-merge case (where the row's
    // historySeq was donated by the companion at seq=N+1) and the
    // un-merged case (separate ack + companion rows at seqs N and
    // N+1).
    let mutated = false;
    for (const thread of state.threads) {
      const anchorCovered = coveredSeqsByAnchor.get(thread.id);
      // No covered set for this thread by anchor AND no session-wide
      // message_id matches → nothing to drop here.
      if (!anchorCovered && coveredSeqsByMessageId.size === 0) continue;
      const filtered: ThreadMessage[] = [];
      for (const r of thread.responses) {
        if (typeof r.historySeq !== "number") {
          filtered.push(r);
          continue;
        }
        const isCovered =
          (anchorCovered && anchorCovered.has(r.historySeq)) ||
          coveredSeqsByMessageId.has(r.historySeq);
        if (!isCovered) {
          filtered.push(r);
          continue;
        }
        // Defense-in-depth: only drop rows whose hydrated counterpart
        // is genuinely background. If `messages[]` is missing (older
        // server) the row is preserved (no covered match anyway).
        const meta = rowBySeq.get(r.historySeq);
        if (meta && meta.source !== "background") {
          // Meta says non-background — protect even if covered set
          // included the seq (defensive against an upstream bug).
          filtered.push(r);
          continue;
        }
        mutated = true;
      }
      if (filtered.length !== thread.responses.length) {
        thread.responses = filtered;
      }
    }
    if (mutated) {
      // Bump the snapshot version so downstream selectors recompute.
      version++;
      snapshotCache.delete(key);
    }
  }

  // Emit each envelope as a completion bubble. `appendCompletionBubble`
  // is idempotent via its `messageId` dedup, so a live-wire envelope
  // already placed for the same row is a no-op. The legacy spawn-ack
  // row (if it survived to this point) is upgraded in place by the
  // existing `appendCompletionBubble` placeholder-upgrade path; if the
  // dedup loop above already deleted it, this call appends fresh.
  for (const e of envelopes) {
    const placementKey = e.thread_id ?? e.response_to_client_message_id;
    if (!placementKey) continue;
    appendCompletionBubble(placementKey, {
      text: e.content,
      media: e.media ?? [],
      spawnComplete: true,
      sourceClientMessageId: e.response_to_client_message_id,
      historySeq: e.seq,
      messageId: e.message_id,
      persistedAt: e.persisted_at,
      sessionId,
      topic,
    });
  }
  notify();
}

/**
 * Ingest a single persisted `MessageInfo` (e.g. from a `session_result`
 * notification on the WS bridge) into the appropriate thread without
 * replaying the whole session.
 *
 * Closes the M8.10 wave-6 leak: pre-fix, late `session_result` events for
 * deep_research / mofa / run_pipeline turns landed only in the legacy
 * MessageStore — which the v2 renderer ignores — leaving the v2 UI stuck
 * on the finalized spawn-ack. The WS event router now calls this helper
 * (M9-α-5/α-6 deleted the SSE bridge that previously fanned out the same
 * event) so the persisted record reaches `ThreadStore.responses`.
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

  // M10 Phase 5b: the legacy ADJACENT splice-merge (`isMediaOnlyCompanion`
  // + adjacent-seq) is removed. That predicate folded a media-only
  // persisted row into the *prior* text bubble — a fragile assumption
  // that the late row was a "companion" of the immediately-prior text
  // response, producing 5+ waves of bugs (sticky-map drift,
  // phantom-chunk drop, wrong-bubble target). Each persisted assistant
  // row is now its own bubble; the renderer supports N>=1 assistant
  // bubbles per user prompt via `responses.map`. For `spawn_only`
  // completions the `turn/spawn_complete` envelope (server PR #772)
  // delivers content + media in one atomic event; the per-file
  // companion `message/persisted` rows are filtered server-side under
  // `event.spawn_complete.v1` (PR #773, Phase 5a).
  //
  // KEPT: the file-deduplication collapse below. Legacy SSE flows can
  // deliver the same file twice (a `file` event attaches it to the
  // pending/most-recent assistant slot via `appendAssistantFile`, then
  // a `session_result` event re-persists the same row). Without the
  // dedupe a non-spawn legacy file delivery would now render two
  // bubbles holding the same MP3/PNG. Codex Phase 5b review P1/P2.
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

  // M9-γ-3 dual-write: a persisted assistant row corresponds to an
  // `assistant_persisted` envelope. Tool/system rows have no projection
  // counterpart in γ-2 (the projection's payload tagged-union doesn't
  // carry tool-result rows — they live as `tool_end` + per-tool
  // progress). Limit the dual-write to assistant rows for now; γ-5
  // will fold tool persistence into the projection's surface.
  if (isProjectionV1Enabled() && built.role === "assistant") {
    const key = projectionStoreKey(sessionId, topic);
    const messageId = built.id;
    const persistedAt = message.timestamp
      ? new Date(message.timestamp).toISOString()
      : new Date().toISOString();
    const media = (message.media ?? []).slice();
    shimIngest(key, threadId, {
      type: "assistant_persisted",
      data: {
        text: built.text,
        meta: {
          message_id: messageId,
          persisted_at: persistedAt,
          ...(media.length > 0 ? { media } : {}),
        },
      },
    }, built.historySeq !== undefined ? { seq: built.historySeq } : undefined);
  }
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

/** Max pages to walk. Mirrors the server-side offset cap (10_000) /
 *  per-page limit (500) so a runaway page-loop cannot pin the tab. */
const HISTORY_PAGE_LIMIT = 500;
const HISTORY_MAX_PAGES = 20;

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
      // Issue #110.3: page through `getMessagesPage` so a session
      // with >500 persisted messages renders ALL of them. Pre-fix
      // every caller hard-coded `getMessages(..., 500, 0, ...)` and
      // dropped everything past row 500 with no signal to the user.
      // The first page is replayed immediately so the UI is
      // populated quickly; subsequent pages accumulate and re-replay
      // (replayHistory carries pending assistants across rebuilds).
      const accumulated: MessageInfo[] = [];
      let offset = 0;
      for (let i = 0; i < HISTORY_MAX_PAGES; i += 1) {
        const page = await getMessagesPage(
          sessionId,
          HISTORY_PAGE_LIMIT,
          offset,
          undefined,
          topic,
        );
        accumulated.push(...page.messages);
        replayHistory(sessionId, accumulated.slice(), topic);
        if (!page.has_more) break;
        // Defensive: server's `next_offset` should always advance,
        // but if the field is missing or stuck, increment manually.
        const nextOffset =
          typeof page.next_offset === "number" && page.next_offset > offset
            ? page.next_offset
            : offset + page.messages.length;
        if (nextOffset === offset) break;
        offset = nextOffset;
      }
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

/**
 * Snapshot of the pending streaming assistant for a given thread.
 * Returns null when the thread doesn't exist or has no pending slot.
 * M9-γ-6 (issue #843): replaces the legacy
 * `MessageStore.getMessages(...).find(m => m.id === assistantMsgId)`
 * lookup the bridge used to detect "stream ended without `done`"
 * conditions.
 */
export function getPendingAssistantSnapshot(
  sessionId: string,
  threadId: string,
  topic?: string,
): { text: string; status: "streaming" | "complete" | "error" } | null {
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return null;
  const thread = state.byId.get(threadId);
  if (!thread || !thread.pendingAssistant) return null;
  const p = thread.pendingAssistant;
  return { text: p.text, status: p.status };
}

/**
 * Highest server-side `historySeq` observed for any persisted message
 * in this session/topic. Returns -1 when no persisted messages have
 * been ingested. M9-γ-6 (issue #843): replaces
 * `MessageStore.getMaxHistorySeq` for the task-watcher's incremental
 * sync cursor.
 */
export function getMaxHistorySeq(
  sessionId: string,
  topic?: string,
): number {
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return -1;
  let max = -1;
  for (const t of state.threads) {
    if (typeof t.userMsg.historySeq === "number" && t.userMsg.historySeq > max) {
      max = t.userMsg.historySeq;
    }
    for (const r of t.responses) {
      if (typeof r.historySeq === "number" && r.historySeq > max) {
        max = r.historySeq;
      }
    }
    if (
      t.pendingAssistant &&
      typeof t.pendingAssistant.historySeq === "number" &&
      t.pendingAssistant.historySeq > max
    ) {
      max = t.pendingAssistant.historySeq;
    }
  }
  return max;
}

/**
 * Flat list of file paths attached to any message in this session/topic.
 * M9-γ-6 (issue #843): replaces the task-watcher's
 * `MessageStore.getMessages(...).flatMap(m => m.files.map(f => f.path))`
 * call without exposing the legacy flat-`Message[]` shape.
 */
export function getKnownFilePaths(
  sessionId: string,
  topic?: string,
): string[] {
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return [];
  const out: string[] = [];
  for (const t of state.threads) {
    for (const f of t.userMsg.files) out.push(f.path);
    for (const r of t.responses) {
      for (const f of r.files) out.push(f.path);
    }
    if (t.pendingAssistant) {
      for (const f of t.pendingAssistant.files) out.push(f.path);
    }
  }
  return out;
}

export function clearSession(sessionId: string, topic?: string): void {
  const key = storeKey(sessionId, topic);
  if (topic?.trim()) {
    sessionsByKey.delete(key);
    loadedSessions.delete(key);
    loadingPromises.delete(key);
    hydrateSnapshotByKey.delete(key);
    pendingClientMessageIds.delete(key);
  } else {
    for (const k of [...sessionsByKey.keys()]) {
      if (k === sessionId || k.startsWith(`${sessionId}#`)) {
        sessionsByKey.delete(k);
        loadedSessions.delete(k);
        loadingPromises.delete(k);
        hydrateSnapshotByKey.delete(k);
        pendingClientMessageIds.delete(k);
      }
    }
    // Codex round-5 P3: a hydrate snapshot may exist without a
    // matching `sessionsByKey` entry (the bridge cached the snapshot
    // before REST `replayHistory` populated thread state). The
    // sessionsByKey-only loop above misses it; sweep
    // `hydrateSnapshotByKey` independently so a clear-then-replay
    // sequence doesn't apply stale envelopes.
    for (const k of [...hydrateSnapshotByKey.keys()]) {
      if (k === sessionId || k.startsWith(`${sessionId}#`)) {
        hydrateSnapshotByKey.delete(k);
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
  hydrateSnapshotByKey.clear();
  pendingClientMessageIds.clear();
  version = 0;
  idCounter = 0;
}
