/**
 * M9-γ-2: Pure-function projection `(envelopes) → ChatViewModel`.
 *
 * Spec: `api/OCTOS_UI_PROTOCOL_V1_SPEC_2026-04-24.md` § 14
 *       "M9-γ Envelope".
 * ADR:  `docs/M9-GAMMA-SERVER-PROJECTION-ADR.md`.
 * UPCR: `UPCR-2026-014`.
 *
 * This module is the deterministic foundation for the M9-γ projection
 * client. It is intentionally pure:
 *
 *   - No React, no hooks, no `notify()`.
 *   - No `Date.now()`, no random IDs, no fetch.
 *   - No imports from `thread-store` / `message-store` (γ-3 wires them up).
 *
 * Given the same `Envelope[]`, `project()` produces a byte-identical
 * `ChatViewModel`. Identity is `(thread_id, seq)` — NOT `client_message_id`
 * and NOT `messageId`. Per the ADR, `turn_completed` is a hard barrier:
 * subsequent payloads on the same `thread_id` are dropped (the projection
 * itself does not desync the connection — that's the bridge's job — but
 * it WILL ignore the trailing envelopes and bump the
 * `droppedAfterTurnCompleted` counter on `projectWithMetrics`).
 *
 * Stable references:
 *
 *   - `threads` is an ordered array; insertion order = first-seen seq for
 *     each `thread_id`. We don't sort by `thread_id` (no spec guarantee).
 *   - Inside each `ThreadView`, `toolCalls` is keyed on `tool_call_id` and
 *     ordered by first-seen seq. `files` is ordered by seq.
 *
 * The projection is a left-fold: it never mutates the input. We accept
 * `ReadonlyArray<Envelope>` and treat the array as append-only.
 */

import type {
  Envelope,
  EnvelopeTokenUsage,
  EnvelopeToolEndStatus,
  MessageMeta,
  Payload,
} from "../runtime/ui-protocol-types";

// ─── ChatViewModel shape ───────────────────────────────────────────────────
//
// The shape is intentionally narrow: just enough for the M9-γ-3 cutover
// of `chat-thread.tsx` and the M9-γ-4 `<GhostBubble>` overlay. We don't
// pre-bake legacy fields (e.g. timestamps minted by `Date.now()`); the
// rendering layer can derive display metadata from `meta.persisted_at`
// when an `assistant_persisted` envelope has finalized the bubble.

export interface UserView {
  /** First seq in this thread; used as a stable identity for the row. */
  seq: number;
  /** The optimistic-token reflection from `client_message_id`, if the
   *  server included one on the user-message-rooted envelope. The
   *  projection does not consult this for identity; it surfaces the
   *  field so γ-4's `<GhostBubble>` overlay can match-and-unmount. */
  client_message_id?: string;
}

export interface AssistantView {
  /** Concatenated streamed text from `assistant_delta` envelopes (in
   *  `seq` order), or the persisted full text from
   *  `assistant_persisted` once it lands. */
  text: string;
  /** Set when an `assistant_persisted` envelope has finalized the
   *  bubble. Carries the durable row identity, commit timestamp, and
   *  attachments. */
  meta: MessageMeta | null;
  /** True iff at least one `assistant_persisted` envelope has been
   *  observed for this thread. */
  persisted: boolean;
}

export interface ToolCallView {
  tool_call_id: string;
  name: string;
  /** Progress messages appended in `seq` order. */
  progress: ReadonlyArray<string>;
  /** `null` until a `tool_end` envelope arrives. */
  status: EnvelopeToolEndStatus | null;
  /** Set iff `status === "error"`. */
  error: string | null;
}

export interface FileView {
  /** The seq the `file_attached` envelope arrived on; stable identity
   *  for the row, useful as a React key. */
  seq: number;
  path: string;
  mime: string;
  size_bytes: number;
}

export interface ThreadView {
  thread_id: string;
  /** Built from the first envelope that introduces this thread (see §
   *  14.1: user-message-rooted envelopes carry `client_message_id`). */
  user: UserView | null;
  /** Accumulates from `assistant_delta` + finalized by
   *  `assistant_persisted`. `null` until at least one assistant payload
   *  has been observed. */
  assistant: AssistantView | null;
  /** Tool calls in first-seen order. */
  toolCalls: ReadonlyArray<ToolCallView>;
  /** Files in arrival order. */
  files: ReadonlyArray<FileView>;
  /** `true` once a `turn_completed` envelope has been observed for this
   *  thread. Subsequent envelopes on the same `thread_id` are dropped. */
  completed: boolean;
  /** Token usage from `turn_completed`. `null` until completion. */
  tokenUsage: EnvelopeTokenUsage | null;
}

export interface ChatViewModel {
  /** Threads ordered by first-seen seq. The projection does not sort
   *  alphabetically by `thread_id` — there is no spec guarantee that
   *  thread_ids carry a meaningful collation order. */
  threads: ReadonlyArray<ThreadView>;
}

// ─── Projection metrics (optional) ─────────────────────────────────────────

/** Counters surfaced for telemetry / debug overlays. The projection
 *  itself is pure; these counters are derived from the same fold and
 *  returned alongside the view-model when the caller wants them. */
export interface ProjectionMetrics {
  /** Number of envelopes ignored because `(thread_id, seq)` was already
   *  applied (idempotency). */
  duplicates: number;
  /** Number of envelopes ignored because they arrived after a
   *  `turn_completed` for the same thread (hard-barrier enforcement). */
  droppedAfterTurnCompleted: number;
  /** Number of envelopes ignored because their `seq` was strictly less
   *  than the highest seq already observed in the same thread (the
   *  projection treats out-of-order seqs as duplicates of an earlier
   *  state and drops them). Distinct from `duplicates`, which counts
   *  exact-match `(thread_id, seq)` collisions. */
  outOfOrder: number;
}

export interface ProjectionResult {
  view: ChatViewModel;
  metrics: ProjectionMetrics;
}

// ─── Projection ────────────────────────────────────────────────────────────

/** Build a `ChatViewModel` from a committed envelope log. Pure and
 *  deterministic: same input ⇒ same output. */
export function project(envelopes: ReadonlyArray<Envelope>): ChatViewModel {
  return projectWithMetrics(envelopes).view;
}

/** Variant that surfaces the metrics counters alongside the view. */
export function projectWithMetrics(
  envelopes: ReadonlyArray<Envelope>,
): ProjectionResult {
  // Per-thread mutable accumulator — converted to immutable `ThreadView`
  // on the way out. We carry a `Set<seq>` for idempotency and a separate
  // `lastSeq` for out-of-order detection (cheaper than scanning the set).
  interface ThreadAcc {
    thread_id: string;
    user: UserView | null;
    assistantText: string;
    assistantMeta: MessageMeta | null;
    assistantPersisted: boolean;
    assistantSeen: boolean;
    toolOrder: string[]; // `tool_call_id` first-seen order
    tools: Map<string, MutableToolCall>;
    files: FileView[];
    completed: boolean;
    tokenUsage: EnvelopeTokenUsage | null;
    seenSeqs: Set<number>;
    lastSeq: number; // -Infinity sentinel: -1, since seqs are u64 ≥ 0
  }
  interface MutableToolCall {
    tool_call_id: string;
    name: string;
    progress: string[];
    status: EnvelopeToolEndStatus | null;
    error: string | null;
  }

  // Map preserves insertion order — first-seen seq order across threads.
  const threadOrder: string[] = [];
  const threads = new Map<string, ThreadAcc>();

  let duplicates = 0;
  let droppedAfterTurnCompleted = 0;
  let outOfOrder = 0;

  const getThread = (thread_id: string): ThreadAcc => {
    const existing = threads.get(thread_id);
    if (existing) return existing;
    const fresh: ThreadAcc = {
      thread_id,
      user: null,
      assistantText: "",
      assistantMeta: null,
      assistantPersisted: false,
      assistantSeen: false,
      toolOrder: [],
      tools: new Map(),
      files: [],
      completed: false,
      tokenUsage: null,
      seenSeqs: new Set(),
      lastSeq: -1,
    };
    threads.set(thread_id, fresh);
    threadOrder.push(thread_id);
    return fresh;
  };

  for (const env of envelopes) {
    const thread = getThread(env.thread_id);

    // Idempotency: dedup by (thread_id, seq).
    if (thread.seenSeqs.has(env.seq)) {
      duplicates += 1;
      continue;
    }

    // Hard barrier: drop anything after turn_completed for this thread.
    if (thread.completed) {
      droppedAfterTurnCompleted += 1;
      continue;
    }

    // Out-of-order guard: a strictly-lower seq than the high-water mark
    // is treated as a duplicate of an earlier state and dropped.
    if (env.seq < thread.lastSeq) {
      outOfOrder += 1;
      continue;
    }

    thread.seenSeqs.add(env.seq);
    thread.lastSeq = env.seq;

    // Capture user identity from the FIRST envelope we see in this
    // thread. Per the spec, user-message-rooted envelopes carry
    // `client_message_id` — the projection records the seq + token but
    // does not depend on the token for identity.
    if (thread.user === null) {
      thread.user = {
        seq: env.seq,
        ...(env.client_message_id !== undefined
          ? { client_message_id: env.client_message_id }
          : {}),
      };
    }

    applyPayload(thread, env.payload);
  }

  // Freeze into immutable view shape.
  const threadViews: ThreadView[] = threadOrder.map((thread_id) => {
    const acc = threads.get(thread_id)!;
    const assistant: AssistantView | null = acc.assistantSeen
      ? {
          text: acc.assistantText,
          meta: acc.assistantMeta,
          persisted: acc.assistantPersisted,
        }
      : null;
    const toolCalls: ToolCallView[] = acc.toolOrder.map((tcId) => {
      const t = acc.tools.get(tcId)!;
      return {
        tool_call_id: t.tool_call_id,
        name: t.name,
        progress: t.progress.slice(),
        status: t.status,
        error: t.error,
      };
    });
    return {
      thread_id: acc.thread_id,
      user: acc.user,
      assistant,
      toolCalls,
      files: acc.files.slice(),
      completed: acc.completed,
      tokenUsage: acc.tokenUsage,
    };
  });

  return {
    view: { threads: threadViews },
    metrics: { duplicates, droppedAfterTurnCompleted, outOfOrder },
  };

  // ── inner: payload dispatch ───────────────────────────────────────────
  function applyPayload(
    thread: ThreadAcc,
    payload: Payload,
  ): void {
    switch (payload.type) {
      case "assistant_delta": {
        thread.assistantSeen = true;
        // Only accumulate text if not yet finalized. After
        // `assistant_persisted`, the persisted text is canonical and
        // late deltas (which the wire contract forbids inside a turn,
        // but a bug-tolerant projection should not corrupt) do not
        // overwrite it.
        if (!thread.assistantPersisted) {
          thread.assistantText += payload.data.text;
        }
        return;
      }
      case "assistant_persisted": {
        thread.assistantSeen = true;
        thread.assistantText = payload.data.text;
        thread.assistantMeta = payload.data.meta;
        thread.assistantPersisted = true;
        return;
      }
      case "tool_start": {
        const id = payload.data.tool_call_id;
        if (thread.tools.has(id)) {
          // Re-`tool_start` for an existing id: spec doesn't define
          // this; we keep the existing card (first-seen wins) and let
          // `name` be carried from the first start.
          return;
        }
        thread.tools.set(id, {
          tool_call_id: id,
          name: payload.data.name,
          progress: [],
          status: null,
          error: null,
        });
        thread.toolOrder.push(id);
        return;
      }
      case "tool_progress": {
        const id = payload.data.tool_call_id;
        const tool = thread.tools.get(id);
        if (!tool) {
          // Progress without a prior start: open a card with an empty
          // name. This keeps the projection total — the bridge can
          // surface a warning separately.
          const opened: MutableToolCall = {
            tool_call_id: id,
            name: "",
            progress: [payload.data.message],
            status: null,
            error: null,
          };
          thread.tools.set(id, opened);
          thread.toolOrder.push(id);
          return;
        }
        tool.progress.push(payload.data.message);
        return;
      }
      case "tool_end": {
        const id = payload.data.tool_call_id;
        const tool = thread.tools.get(id);
        if (!tool) {
          const opened: MutableToolCall = {
            tool_call_id: id,
            name: "",
            progress: [],
            status: payload.data.status,
            error:
              payload.data.status === "error"
                ? payload.data.error ?? null
                : null,
          };
          thread.tools.set(id, opened);
          thread.toolOrder.push(id);
          return;
        }
        tool.status = payload.data.status;
        tool.error =
          payload.data.status === "error"
            ? payload.data.error ?? null
            : null;
        return;
      }
      case "file_attached": {
        // We could attach the file to the most-recent assistant bubble
        // (per spec § 14.2) but the per-thread `files` collection is
        // simpler and equivalent for the M9-γ-2 surface — γ-3 will
        // decide whether to inline these into the assistant view. For
        // now we record arrival order keyed on seq.
        thread.files.push({
          // The current envelope's seq lives on `thread.lastSeq` —
          // which we've just set.
          seq: thread.lastSeq,
          path: payload.data.path,
          mime: payload.data.mime,
          size_bytes: payload.data.size_bytes,
        });
        return;
      }
      case "turn_completed": {
        thread.completed = true;
        thread.tokenUsage = payload.data.token_usage;
        return;
      }
      default: {
        // Exhaustiveness guard. If a new variant lands without a
        // projection update, TS will fail this assignment.
        const _exhaustive: never = payload;
        void _exhaustive;
        return;
      }
    }
  }
}
