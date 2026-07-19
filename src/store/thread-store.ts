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
 * The canonical renderer reads ProjectionStore. This store remains available
 * for compatibility event bookkeeping and shared presentation types; it is
 * not a chat render source.
 */

import { displayFilenameFromPath } from "@/lib/utils";
import { recordRuntimeCounter } from "@/runtime/observability";
import { SPAWN_ONLY_TOOL_NAMES } from "@/runtime/spawn-only-tools";

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
  /** Raw arguments captured from the tool_start event. */
  args?: unknown;
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
  /** Per-thread sequence used for compatibility-event response ordering. */
  intra_thread_seq?: number;
  meta?: MessageMeta;
  /**
   * For assistant/tool messages: parent thread root cmid.
   *
   * @deprecated Canonical v2 carries this on `user_message` envelopes.
   * Retained for compatibility-event routing.
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
  /** Explicit server turn identity when the canonical v2 render adapter is
   * active. */
  turnId?: string;
  /** Render-only marker for a canonical background child stream. It is a
   * linked stream, not another response appended to its parent turn. */
  backgroundChild?: boolean;
  /** Canonical parent linkage for `backgroundChild` render rows. */
  parentTurnId?: string;
  responseToClientMessageId?: string;
  userMsg: ThreadMessage;
  /** Assistant + tool messages bound to this thread, ordered by
   *  intra_thread_seq (server-authoritative) with arrival-order fallback. */
  responses: ThreadMessage[];
  /** In-flight assistant message for the current turn (becomes part of
   *  `responses` when `finalizeAssistant` is called). */
  pendingAssistant: ThreadMessage | null;
  /** Set when this bucket was MINTED as an orphan placeholder (a late
   *  event arrived before its user message). Cleared when the real
   *  user message adopts the bucket. While set, the thread's turn-ness
   *  is UNKNOWN — the underlying turn may exist server-side and simply
   *  not be hydrated yet — so rollback math must not run against a
   *  list containing one (codex #262 round 2: shape-inference
   *  misclassified a persisted-but-unhydrated turn as a non-turn and
   *  sent a destructive num_turns for the wrong bubble). */
  placeholderOrigin?: boolean;
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

function notify() {
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

/** Pick the most-recent thread whose user message is non-empty (i.e. a
 *  real user-typed prompt, not a synthesised placeholder). Used by
 *  `appendCompletionBubble` when the envelope's `thread_id` doesn't
 *  match any stored thread — rather than mint a brand-new orphan with
 *  an empty user placeholder (which visually disconnects the failure /
 *  completion bubble from the user prompt that triggered it), we
 *  attribute the bubble to the most-recent user prompt in the session.
 *
 *  Returns `null` when no user-rooted thread is present (e.g. the SPA
 *  reloaded mid-stream and the user message hasn't been re-hydrated
 *  yet) — the caller then falls back to the orphan-placeholder branch. */
function pickMostRecentNonEmptyUserThread(state: SessionState): Thread | null {
  for (let i = state.threads.length - 1; i >= 0; i -= 1) {
    const t = state.threads[i];
    if (t.userMsg.text.length > 0 || t.userMsg.files.length > 0) return t;
  }
  return null;
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
    placeholderOrigin: true,
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

/** Replace an assistant slot's `ThreadMessage` reference in-thread.
 *
 *  Bug 2026-05-15: `appendToolProgress` / `setToolCallStatus` / `addToolCall`
 *  used to mutate the existing `ThreadMessage` (push onto
 *  `entry.progress`, replace `tcs[idx]` in place). The bubble renderer
 *  wraps `ThreadAssistantBubble` in `React.memo`, whose default shallow
 *  comparison treats `message === message` as "skip re-render". So
 *  after the foreground turn finalised (`pendingAssistant -> responses`),
 *  every subsequent `tool/progress` heartbeat for a spawn_only
 *  `run_pipeline` mutated state in the store but never repainted the
 *  bubble — the user saw the bubble freeze on the 3rd/4th line of a
 *  20-minute pipeline run.
 *
 *  Fix: every mutation that changes a tool call's data MUST replace the
 *  containing `ThreadMessage` with a fresh object. This helper writes
 *  the new ref into either `thread.pendingAssistant` or the matching
 *  `thread.responses[i]` slot.
 *
 *  Returns the new `ThreadMessage` reference so the caller can keep
 *  working with it for the remainder of the mutation.
 */
function replaceAssistantSlot(
  thread: Thread,
  oldSlot: ThreadMessage,
  newSlot: ThreadMessage,
): ThreadMessage {
  if (thread.pendingAssistant === oldSlot) {
    thread.pendingAssistant = newSlot;
    return newSlot;
  }
  const idx = thread.responses.indexOf(oldSlot);
  if (idx !== -1) {
    thread.responses[idx] = newSlot;
    return newSlot;
  }
  // Slot vanished between read and write (shouldn't happen under
  // single-threaded JS, but guard anyway). Caller's `oldSlot` reference
  // is the only thing left holding the data — return it so the caller
  // can still notify on its mutations even if no live anchor exists.
  return oldSlot;
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
    // The real user message arrived — the bucket is a known turn now.
    existing.placeholderOrigin = false;
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
      // The real user message arrived — the bucket is a known turn now.
      placeholderOrigin: false,
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
  args?: unknown,
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
  //
  // Bug 2026-05-15: see `replaceAssistantSlot` for the React.memo
  // freeze that motivates the immutable updates below.
  //
  // Bug 2026-05-15 (codex final-3 gap 1): when an existing tool call is
  // already in a terminal state (`"complete"` or `"error"`), preserve
  // that status — DO NOT force it back to `"running"`. Pre-fix, a
  // replayed `tool/started` for a settled task reverted the chip to
  // running, re-activating every in-bubble spinner gate. Idempotent
  // re-registration is fine; reopening a settled tool call is the bug.
  if (toolCallId) {
    for (const candidate of [
      found.thread.pendingAssistant,
      ...[...found.thread.responses].reverse(),
    ]) {
      if (!candidate) continue;
      const idx = candidate.toolCalls.findIndex((tc) => tc.id === toolCallId);
      if (idx !== -1) {
        const existing = candidate.toolCalls[idx];
        // Preserve terminal status — only flip to "running" when the
        // tool call has not yet settled.
        const preservedStatus =
          existing.status === "complete" || existing.status === "error"
            ? existing.status
            : ("running" as const);
        const newTcs = candidate.toolCalls.map((tc, i) => {
          if (i !== idx) return tc;
          return {
            ...tc,
            status: preservedStatus,
            ...(args !== undefined ? { args } : {}),
          };
        });
        replaceAssistantSlot(found.thread, candidate, {
          ...candidate,
          toolCalls: newTcs,
        });
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
      const existing = tcs[byId];
      // Bug 2026-05-15 (codex final-3 gap 1): preserve terminal status —
      // see the cross-slot branch above for the same logic.
      const preservedStatus =
        existing.status === "complete" || existing.status === "error"
          ? existing.status
          : ("running" as const);
      const newTcs = tcs.map((tc, i) => {
        if (i !== byId) return tc;
        return {
          ...tc,
          status: preservedStatus,
          ...(args !== undefined ? { args } : {}),
        };
      });
      replaceAssistantSlot(found.thread, slot, {
        ...slot,
        toolCalls: newTcs,
      });
      notify();
      return;
    }
  }

  // Collapse retry: most recent call has same name → bump retryCount.
  const last = tcs[tcs.length - 1];
  if (last && last.name === name) {
    const collapsed: ThreadToolCall = {
      ...last,
      id: toolCallId,
      ...(args !== undefined ? { args } : {}),
      status: "running",
      retryCount: last.retryCount + 1,
      // Carry forward progress so the user keeps the running narration.
      progress: last.progress,
    };
    const newTcs = [...tcs.slice(0, -1), collapsed];
    replaceAssistantSlot(found.thread, slot, {
      ...slot,
      toolCalls: newTcs,
    });
    notify();

    return;
  }

  const newTcs = [
    ...tcs,
    {
      id: toolCallId,
      name,
      ...(args !== undefined ? { args } : {}),
      status: "running" as const,
      progress: [],
      retryCount: 0,
    },
  ];
  replaceAssistantSlot(found.thread, slot, {
    ...slot,
    toolCalls: newTcs,
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

  // Defect B (M9 follow-up, 2026-05-22): when `pickAssistantSlot`
  // returns the most-recent assistant slot but the toolCallId actually
  // lives on an EARLIER slot (e.g. the originating bubble was
  // finalised into `thread.responses`, then a NEW user prompt minted a
  // fresh pendingAssistant), the legacy lookup missed and minted a
  // stub `{id: toolCallId, name: toolName ?? "", status: "running"}`
  // on the new slot — rendering as a second, empty ToolCallBubble
  // titled "tool". Mirror `setToolCallStatus`'s thread-wide scan
  // (pending + every assistant response, most-recent-first) so a late
  // progress chunk always routes back to its originating bubble.
  let containingSlot: ThreadMessage | null = null;
  let entryIdx = -1;
  if (toolCallId && slot) {
    const idxOnSlot = slot.toolCalls.findIndex((tc) => tc.id === toolCallId);
    if (idxOnSlot !== -1) {
      containingSlot = slot;
      entryIdx = idxOnSlot;
    }
  }
  if (containingSlot === null && toolCallId) {
    // Scan every assistant slot in this thread, most-recent first, for
    // a tool call owning `toolCallId`. The pending slot (if any) gets
    // priority because that's the slot a successful `pickAssistantSlot`
    // would have returned; falling through to finalised responses
    // catches the defect-B case where the originating slot is already
    // in `thread.responses`.
    const candidates: ThreadMessage[] = [];
    if (found.thread.pendingAssistant) {
      candidates.push(found.thread.pendingAssistant);
    }
    for (let i = found.thread.responses.length - 1; i >= 0; i -= 1) {
      const candidate = found.thread.responses[i];
      if (candidate.role === "assistant") candidates.push(candidate);
    }
    for (const candidate of candidates) {
      const idxOnCandidate = candidate.toolCalls.findIndex(
        (tc) => tc.id === toolCallId,
      );
      if (idxOnCandidate !== -1) {
        containingSlot = candidate;
        entryIdx = idxOnCandidate;
        break;
      }
    }
  }
  if (containingSlot === null && !toolCallId && toolName && slot) {
    // Legacy daemon path — no tool_call_id on the wire. Route by tool
    // name to the most recent matching call on the picked slot. Same
    // semantics as the pre-defect-B code.
    for (let i = slot.toolCalls.length - 1; i >= 0; i -= 1) {
      if (slot.toolCalls[i].name === toolName) {
        containingSlot = slot;
        entryIdx = i;
        break;
      }
    }
  }
  // No matching tool call anywhere in the thread — fall back to the
  // picked slot (or open a new pending) and mint a stub. This is the
  // legitimate "late-arriving progress for a tool we missed start
  // for" path, e.g. SSE resumed mid-stream. With the thread-wide scan
  // above, this branch fires only when truly no prior slot owns the
  // id — the spurious stub on a fresh slot defect B reported can no
  // longer happen.
  const oldTarget =
    containingSlot ?? slot ?? ensurePendingAssistant(found.thread);

  // Bug 2026-05-15: previously this function pushed onto
  // `entry.progress` and kept the surrounding `ThreadMessage` reference
  // identical. `ThreadAssistantBubble` is wrapped in `React.memo`, so
  // identical-by-reference `message` props caused subsequent heartbeats
  // (`run_pipeline` emits one every 5s) to update the store WITHOUT
  // repainting the bubble — the user saw only the first 2-3 progress
  // chips for the entire pipeline run. Fix: build a new tool-call entry
  // + tool-call list + ThreadMessage so memo's shallow comparison sees
  // the change.
  const oldTcs = oldTarget.toolCalls;
  const existing = entryIdx === -1 ? undefined : oldTcs[entryIdx];
  // Idempotency guard: skip exact-duplicate consecutive entries so a
  // task_status replay (e.g. on stream reconnect) doesn't double-render
  // the same line in the timeline. Mirrors the logic in
  // `MessageStore.appendToolProgressByCallId`.
  if (existing) {
    const lastEntry = existing.progress[existing.progress.length - 1];
    if (lastEntry && lastEntry.message === message) {
      return;
    }
  }
  const baseEntry: ThreadToolCall = existing ?? {
    // Late-arriving progress for a tool whose start we missed (e.g. SSE
    // resumed mid-stream). Create a stub call so the progress isn't lost.
    id: toolCallId,
    name: toolName ?? "",
    status: "running",
    progress: [],
    retryCount: 0,
  };
  const nextProgress = [
    ...baseEntry.progress,
    { message, ts: Date.now() },
  ];
  // FIFO eviction so a long-running pipeline can't grow the timeline
  // unbounded (the cap matches `MAX_TOOL_PROGRESS_ENTRIES`).
  while (nextProgress.length > MAX_TOOL_PROGRESS_ENTRIES) {
    nextProgress.shift();
  }
  const newEntry: ThreadToolCall = { ...baseEntry, progress: nextProgress };
  const newTcs =
    entryIdx === -1
      ? [...oldTcs, newEntry]
      : oldTcs.map((tc, i) => (i === entryIdx ? newEntry : tc));
  const newTarget: ThreadMessage = { ...oldTarget, toolCalls: newTcs };
  replaceAssistantSlot(found.thread, oldTarget, newTarget);
  notify();

}

export function setToolCallStatus(
  threadId: string,
  toolCallId: string,
  status: ThreadToolCall["status"],
  toolName?: string,
): boolean {
  const found = ensureOrphanThread(threadId);
  if (!found) return false;
  const slot = pickAssistantSlot(found.thread);

  // Resolve the slot that actually contains the tool call. The
  // `pickAssistantSlot` heuristic returns the in-flight pending OR the
  // MOST RECENT finalized response — that's correct for the live path
  // but misses when an EARLIER ack bubble holds the tool card and a
  // later completion bubble has since been appended. Without this
  // fallback the lookup misses and `setToolCallStatus` silently
  // no-ops, leaving the chip's spinner spinning forever (codex
  // final-3 gap 2). When the slot picker misses, fall back to a
  // full-thread scan: find the assistant message in this thread that
  // actually contains a `toolCalls[i].id === toolCallId`.
  let containingSlot: ThreadMessage | null = null;
  let idx = -1;
  if (slot) {
    let tentativeIdx = -1;
    if (toolCallId) {
      tentativeIdx = slot.toolCalls.findIndex((tc) => tc.id === toolCallId);
    } else if (toolName) {
      // Legacy daemon path — route by tool name to the most recent match.
      for (let i = slot.toolCalls.length - 1; i >= 0; i -= 1) {
        if (slot.toolCalls[i].name === toolName) {
          tentativeIdx = i;
          break;
        }
      }
    }
    if (tentativeIdx !== -1) {
      containingSlot = slot;
      idx = tentativeIdx;
    }
  }
  // Slot picker missed → scan every assistant slot in the thread.
  // Cheap; only fires when the happy path missed. Walks
  // pendingAssistant + responses (most-recent-first) so the chosen
  // slot is the same one a future `pickAssistantSlot` would prefer.
  if (idx === -1 && toolCallId) {
    const candidates: ThreadMessage[] = [];
    if (found.thread.pendingAssistant) {
      candidates.push(found.thread.pendingAssistant);
    }
    for (let i = found.thread.responses.length - 1; i >= 0; i -= 1) {
      const candidate = found.thread.responses[i];
      if (candidate.role === "assistant") candidates.push(candidate);
    }
    for (const candidate of candidates) {
      const tentativeIdx = candidate.toolCalls.findIndex(
        (tc) => tc.id === toolCallId,
      );
      if (tentativeIdx !== -1) {
        containingSlot = candidate;
        idx = tentativeIdx;
        break;
      }
    }
  }
  if (!containingSlot || idx === -1) return false;
  // Bug 2026-05-15: see `replaceAssistantSlot` for the React.memo
  // freeze — assigning into `tcs[idx]` keeps the surrounding
  // `ThreadMessage` reference identical and the bubble's terminal
  // status chip never repainted.
  const tcs = containingSlot.toolCalls;
  const newTcs = tcs.map((tc, i) => (i === idx ? { ...tc, status } : tc));
  replaceAssistantSlot(found.thread, containingSlot, {
    ...containingSlot,
    toolCalls: newTcs,
  });
  notify();

  return true;
}

/**
 * M10 Phase 2 (server PR #772): append a NEW assistant row to the thread
 * for a `turn/spawn_complete` envelope. This function ALWAYS adds a fresh
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
  if (!host && opts.sourceClientMessageId) {
    // Phase 4 plumbing: the envelope's `response_to_client_message_id`
    // carries the originating user prompt's cmid. If `thread_id` missed
    // (cross-release wire-shape regression, e.g. a stringified UUID
    // shape mismatch between the server's `bg_thread_id = turn_id` and
    // the SPA's `addUserMessage`'s pinned cmid), the cmid stamped on
    // the user-prompt row is the authoritative anchor. Try it before
    // falling through to the orphan branch — without this, a healthy
    // user prompt thread sits in the chat scroll with NO assistant
    // response, while the failure / completion bubble lands inside a
    // freshly-minted orphan thread bundle whose empty user-placeholder
    // makes the prompt look "vanished" next to the failure text.
    host = findThreadById(opts.sourceClientMessageId);
  }
  if (!host) {
    if (opts.sessionId) {
      const key = storeKey(opts.sessionId, opts.topic);
      const state = ensureSession(key);
      // Bug 2026-05-14 (mini5): when no exact-id host exists, prefer
      // attributing the completion to the most recent thread in the
      // active session whose user message is non-empty. This covers
      // the production-flow case where a spawn_only failure event
      // round-tripped a thread_id that diverged from the SPA's cmid
      // (UUID-stringification asymmetry across releases) — the user's
      // real prompt sits in this active session's threads, and a
      // brand-new orphan with `placeholderUser.text = ""` would
      // visually disconnect the failure bubble from the prompt that
      // triggered it.
      //
      // Attribution target: the most recent user-rooted thread in the
      // active session, picked by `pickMostRecentNonEmptyUserThread`.
      // For sessions with a single user prompt (the failure scenario
      // mini5 surfaced) this is unambiguously correct. For sessions
      // with multiple prompts the heuristic prefers the most recent
      // one — a spawn_only failure landing minutes after the
      // foreground turn finalized is most likely owned by the prompt
      // that initiated the background work, which is also the
      // most-recently-typed prompt unless the user has moved on. If
      // we ever observe the wrong attribution in practice, we can
      // tighten the heuristic to require a `pendingAssistant` or
      // `responses.length === 0` (i.e. "no completed reply yet").
      const candidate = pickMostRecentNonEmptyUserThread(state);
      if (candidate) {
        host = { state, thread: candidate };
        recordRuntimeCounter("octos_thread_completion_attributed_total", {
          surface: "thread_store_completion",
        });
      } else {
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
          placeholderOrigin: true,
        };
        insertThreadInTimestampOrder(state, orphan);
        recordRuntimeCounter("octos_thread_orphan_created_total", {
          surface: "thread_store_completion",
        });
        host = { state, thread: orphan };
      }
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

  // Identity / upgrade-in-place. A replayed completion MUST NOT produce a
  // duplicate row. `messageId` is the strongest identity; `historySeq` is a
  // fallback for callers that do not supply it.

  if (opts.messageId) {
    for (let i = 0; i < thread.responses.length; i += 1) {
      const r = thread.responses[i];
      if (r.id !== opts.messageId) continue;
      // True identity match — this row IS the spawn-complete row.
      // Upgrade an empty placeholder in place; otherwise this is a replay.
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
      // An empty row is a legitimate upgrade target. For a non-empty row,
      // match content as the best available fallback identity.
      if (r.text.length > 0) {
        if (rowMatchesCompletionContent(r, opts)) {
          return true;
        }
        continue;
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

  return true;
}

function parsePersistedAt(persistedAt: string | undefined): number {
  if (!persistedAt) return Date.now();
  const t = new Date(persistedAt).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function fileFromMediaPath(path: string): MessageFile {
  return {
    filename: displayFilenameFromPath(path),
    path,
    caption: "",
  };
}

/** Replace an empty completion placeholder with its authoritative content,
 *  unioning files by path. Used for both identity upgrade paths. */
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

/** Best-effort content match for the `historySeq` fallback when callers omit
 *  `messageId`. */
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

/**
 * Attach a delivered file to the SPECIFIC assistant response that owns
 * `toolCallId`. Used by the `file/attached` envelope router (codex P2
 * round, 2026-05-25): the previous code path mutated the latest
 * assistant message in the thread, which mis-routed deliveries when a
 * turn contained multiple spawn_only completions or when the envelope
 * replayed AFTER another assistant response was appended.
 *
 * Lookup order matches `findThreadIdForToolCall`: pending in-flight
 * assistant first (the spawn_only tool call may still be running), then
 * `responses` most-recent-first (the foreground bubble already
 * finalised).
 *
 * Cross-slot dedupe (codex round 2, 2026-05-25): another compatibility
 * event may already have attached the same `path` to a different assistant
 * slot in the thread. This handler treats the
 * `tool_call_id` envelope as the AUTHORITATIVE placement signal —
 * remove a stale copy from any other assistant slot first, then attach
 * to the owner. Without this, the same artefact would render on two
 * sibling bubbles after the safety net runs (codex 2026-05-25 round 2).
 *
 * Path-deduplicated within the owner slot so repeated envelopes are
 * no-ops.
 *
 * Returns `true` when the file landed on (or was already attached to)
 * the owning bubble, `false` when no assistant message in the thread
 * owns `toolCallId` (caller should fall back or drop).
 */
export function appendAssistantFileToToolCall(
  threadId: string,
  toolCallId: string,
  file: MessageFile,
): boolean {
  if (!toolCallId) return false;
  const found = findThreadById(threadId);
  if (!found) return false;
  const thread = found.thread;

  // Locate the specific assistant message that owns `toolCallId`.
  // Pending first (still-running spawn_only), then finalised responses
  // (most-recent-first matches `findThreadIdForToolCall`).
  let slot: ThreadMessage | null = null;
  if (thread.pendingAssistant?.toolCalls.some((tc) => tc.id === toolCallId)) {
    slot = thread.pendingAssistant;
  } else {
    for (let i = thread.responses.length - 1; i >= 0; i -= 1) {
      const r = thread.responses[i];
      if (r.role !== "assistant") continue;
      if (r.toolCalls.some((tc) => tc.id === toolCallId)) {
        slot = r;
        break;
      }
    }
  }
  if (!slot) return false;

  // Path dedupe on the owner slot: a redundant replay of the same
  // envelope is a no-op. Cross-slot cleanup (stripping stale copies
  // from sibling assistant slots without burning a legitimate
  // distinct-tool-call delivery) is the router's responsibility,
  // because only the router has the claim registry of which
  // `tool_call_id`s have authoritatively claimed which paths
  // (`seenFileAttachments` keyed by `(threadId, tool_call_id, path)`).
  // See `handleFileAttached` for the cross-slot cleanup path.
  const ownerHasPath = slot.files.some((f) => f.path === file.path);
  if (!ownerHasPath) {
    // Codex round-3 immutable-slot fix: `ThreadAssistantBubble` is
    // wrapped in `React.memo`, so mutating `slot.files` in place
    // leaves the memoized bubble holding a stale reference and the
    // repaint never happens. `replaceAssistantSlot` swaps in a fresh
    // `ThreadMessage` so the bubble re-renders.
    replaceAssistantSlot(thread, slot, {
      ...slot,
      files: [...slot.files, file],
    });
    notify();
  }

  return true;
}

/**
 * Remove a file path from a SPECIFIC assistant slot in a thread,
 * identified by any tool_call_id the slot owns. Used by the
 * `file/attached` router's cross-slot dedupe (codex round 4,
 * 2026-05-25): when an authoritative envelope claims `path` for a
 * specific tool_call, the router walks every OTHER slot in the thread
 * and strips stale copies — but only when the router's per-thread
 * claim registry confirms no other tool_call has claimed the same
 * path on that slot.
 *
 * The lookup uses `slotToolCallId` rather than a slot reference
 * because the router only knows tool_call ids, not slot identities;
 * the store finds the assistant message whose `toolCalls` contain
 * `slotToolCallId` and strips `path` from its files via
 * `replaceAssistantSlot` (immutable swap, `React.memo` repaints).
 *
 * Returns `true` when a file was actually stripped, `false` when the
 * slot was not found OR the path was not present.
 */
export function stripFileFromAssistantSlot(
  threadId: string,
  slotToolCallId: string,
  path: string,
): boolean {
  if (!slotToolCallId) return false;
  const found = findThreadById(threadId);
  if (!found) return false;
  const thread = found.thread;

  let slot: ThreadMessage | null = null;
  if (thread.pendingAssistant?.toolCalls.some((tc) => tc.id === slotToolCallId)) {
    slot = thread.pendingAssistant;
  } else {
    for (let i = thread.responses.length - 1; i >= 0; i -= 1) {
      const r = thread.responses[i];
      if (r.role !== "assistant") continue;
      if (r.toolCalls.some((tc) => tc.id === slotToolCallId)) {
        slot = r;
        break;
      }
    }
  }
  if (!slot) return false;
  const idx = slot.files.findIndex((f) => f.path === path);
  if (idx === -1) return false;
  const newFiles = slot.files.filter((_, i) => i !== idx);
  replaceAssistantSlot(thread, slot, { ...slot, files: newFiles });
  notify();
  return true;
}

/**
 * Strip `path` from the no-tool-call sibling that legacy
 * `appendAssistantFile` would have targeted. Used by the
 * `file/attached` router's cross-slot dedupe for the "naive media
 * sibling" pattern: a spawn-ack/foreground bubble with no tool_calls
 * that absorbed the path via the latest-sibling fallback. Slots that
 * own their own tool calls are handled separately by the router via
 * `stripFileFromAssistantSlot` after consulting its claim registry.
 *
 * Returns `true` when a file was stripped, `false` otherwise.
 */
export function stripFileFromNaiveSiblings(
  threadId: string,
  excludeSlotToolCallId: string,
  path: string,
): boolean {
  const found = findThreadById(threadId);
  if (!found) return false;
  const thread = found.thread;
  let mutated = false;

  const tryStrip = (other: ThreadMessage): void => {
    if (other.role !== "assistant") return;
    // Skip the owner slot (carries excludeSlotToolCallId).
    if (
      excludeSlotToolCallId &&
      other.toolCalls.some((tc) => tc.id === excludeSlotToolCallId)
    ) {
      return;
    }
    // Skip slots with their own tool_calls — router handles those.
    if (other.toolCalls.length > 0) return;
    const idx = other.files.findIndex((f) => f.path === path);
    if (idx === -1) return;
    const newFiles = other.files.filter((_, i) => i !== idx);
    replaceAssistantSlot(thread, other, { ...other, files: newFiles });
    mutated = true;
  };
  if (thread.pendingAssistant) tryStrip(thread.pendingAssistant);
  for (const r of [...thread.responses]) tryStrip(r);
  if (mutated) notify();
  return mutated;
}

/**
 * Read-only: list every assistant slot in `threadId` and the
 * tool_call_ids each one owns. Used by the `file/attached` router
 * (codex round 4) to walk siblings carrying the just-claimed path
 * and consult its per-thread claim registry: a sibling slot whose
 * tool_calls intersect the claim set legitimately owns the path;
 * otherwise the copy is stale and the router calls
 * `stripFileFromAssistantSlot` to remove it.
 *
 * Returns pending first, then `responses` in arrival order.
 * Empty when the thread is not found.
 */
export function snapshotAssistantSlots(
  threadId: string,
): { toolCallIds: string[]; paths: string[] }[] {
  const found = findThreadById(threadId);
  if (!found) return [];
  const thread = found.thread;
  const rows: { toolCallIds: string[]; paths: string[] }[] = [];
  if (thread.pendingAssistant && thread.pendingAssistant.role === "assistant") {
    rows.push({
      toolCallIds: thread.pendingAssistant.toolCalls.map((tc) => tc.id),
      paths: thread.pendingAssistant.files.map((f) => f.path),
    });
  }
  for (const r of thread.responses) {
    if (r.role !== "assistant") continue;
    rows.push({
      toolCallIds: r.toolCalls.map((tc) => tc.id),
      paths: r.files.map((f) => f.path),
    });
  }
  return rows;
}

/**
 * Return `true` when `threadId` exists in the (sessionId, topic) scope.
 * Used by the `file/attached` router's turn-id fallback (codex P2, round
 * 2026-05-25) to scope orphan-thread minting to the active session —
 * pre-fix the fallback walked every loaded `SessionState` and could
 * route an artefact to a stale session that was still resident in
 * memory.
 */
export function hasThreadInScope(
  sessionId: string,
  topic: string | undefined,
  threadId: string,
): boolean {
  if (!threadId) return false;
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  if (!state) return false;
  return state.byId.has(threadId);
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
 * router (`handleTurnCompleted` / `handleTurnError`) when the pending bubble
 * has already been finalized — by the time `turn/completed` lands,
 * `pendingAssistant` is null and
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
    if (!thread) continue;
    if (!thread.pendingAssistant) {
      continue;
    }

    // Sweep any still-running tool calls to "complete" — the assistant
    // turn ended, so a tool whose explicit `tool_end` was suppressed or
    // lost over the wire would otherwise leave the chip spinning forever.
    // Only flip running → complete; preserve "error" and existing
    // "complete" entries (tool_end already arrived for those).
    // SPAWN_ONLY EXCEPTION (codex PR #147 review BLOCKER, 2026-05-22):
    // spawn_only tools (`run_pipeline`, `podcast_generate`, `fm_tts`,
    // ...) intentionally fire their foreground `tool/completed` ~ms
    // after `tool/started` — the actual background work runs for
    // minutes after `turn/completed` lands. The real terminal signal
    // for the bubble is `task/updated:completed` (or `:failed`), which
    // `handleTaskUpdated` routes to `setToolCallStatus`. Sweeping the
    // chip to `complete` here would silently undo the Defect A
    // deferral for the second code path — the chip would settle
    // before the background work actually finishes. We leave
    // spawn_only chips alone here; `handleTaskUpdated` flips them
    // when the supervisor task settles.
    const sweptToolCalls = thread.pendingAssistant.toolCalls.map((tc) => {
      if (tc.status === "running") {
        if (SPAWN_ONLY_TOOL_NAMES.has(tc.name)) {
          // Leave spawn_only chips in `running` — the terminal flip
          // comes from `handleTaskUpdated`, not the turn sweep.
          return tc;
        }
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

    return;
  }
}

// ---------------------------------------------------------------------------
export function applyVoiceTranscript(
  sessionId: string,
  topic: string | undefined,
  threadId: string | undefined,
  transcript: string,
): boolean {
  const text = transcript.trim();
  if (!threadId || text.length === 0) return false;
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  const thread = state?.byId.get(threadId);
  if (!thread) return false;
  if (thread.userMsg.text.trim().length > 0) return false;
  thread.userMsg = {
    ...thread.userMsg,
    text,
  };
  notify();
  return true;
}

export function discardOptimisticVoiceTurn(
  sessionId: string,
  topic: string | undefined,
  threadId: string | undefined,
): boolean {
  if (!threadId) return false;
  const key = storeKey(sessionId, topic);
  const state = sessionsByKey.get(key);
  const thread = state?.byId.get(threadId);
  if (!state || !thread) return false;
  const pendingIsEmpty =
    thread.pendingAssistant === null ||
    (thread.pendingAssistant.text.trim().length === 0 &&
      thread.pendingAssistant.files.length === 0 &&
      thread.pendingAssistant.toolCalls.length === 0);
  if (
    thread.userMsg.text.trim().length > 0 ||
    thread.responses.length > 0 ||
    !pendingIsEmpty
  ) {
    return false;
  }
  state.byId.delete(threadId);
  const idx = state.threads.findIndex((t) => t.id === threadId);
  if (idx !== -1) state.threads.splice(idx, 1);
  notify();
  return true;
}

/**
 * Read compatibility-event state for diagnostics and non-render consumers.
 * Dashboard components render exclusively through ProjectionStore.
 */
export function getThreads(sessionId: string, topic?: string): Thread[] {
  return sessionsByKey.get(storeKey(sessionId, topic))?.threads.slice() ?? [];
}

/** True when the thread was minted as an orphan placeholder (a late
 *  assistant/tool event whose user message never landed in the store)
 *  rather than a real persisted user turn: empty text AND no files. A
 *  file-only user message is a real turn (text empty, files non-empty).
 *  Rollback math (`session/rollback` counts persisted USER turns only)
 *  must skip placeholders — counting them both inflates `num_turns`
 *  and grows a Rewind affordance on a bubble that is not a turn.
 *
 *  PROVENANCE, not shape (codex #262 round 2): the flag is set when
 *  the bucket is MINTED as an orphan and cleared when the real user
 *  message adopts it. Shape-inference ("empty text + no files") also
 *  matched real-but-unhydrated turns and empty-text turns replayed by
 *  hydrate, silently shifting relative rollback counts. */
export function isPlaceholderThread(thread: Thread): boolean {
  return thread.placeholderOrigin === true;
}


export function clearSession(sessionId: string, topic?: string): void {
  const key = storeKey(sessionId, topic);
  if (topic?.trim()) {
    sessionsByKey.delete(key);
  } else {
    for (const k of [...sessionsByKey.keys()]) {
      if (k === sessionId || k.startsWith(`${sessionId}#`)) {
        sessionsByKey.delete(k);
      }
    }
  }
  notify();
}

export function clearAllSessions(): void {
  sessionsByKey.clear();
  notify();
}

if (typeof window !== "undefined") {
  window.addEventListener("crew:token_cleared", clearAllSessions);
}

export function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
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

/** Test-only helper: reset all in-memory state. */
export function __resetForTests(): void {
  sessionsByKey.clear();
  listeners.clear();
  idCounter = 0;
}
