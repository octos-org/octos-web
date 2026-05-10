/**
 * M9-γ-2: Pure-function projection `(envelopes) → ChatViewModel`.
 *
 * Spec: `api/OCTOS_UI_PROTOCOL_V1_SPEC_2026-04-24.md` § 14
 *       "M9-γ Envelope".
 * ADR:  `docs/M9-GAMMA-SERVER-PROJECTION-ADR.md`.
 * UPCR: `UPCR-2026-014`.
 *
 * Pure: no React, no hooks, no Date.now, no fetch. Same `Envelope[]`
 * input ⇒ byte-identical `ChatViewModel`. Identity is `(thread_id, seq)`.
 *
 * **Order-independence (codex BLOCK 1, 2)**: out-of-order envelopes are
 * BUFFERED, not dropped. Each thread tracks `expectedNextSeq`. Arrivals
 * with `seq > expectedNextSeq` are buffered as gap candidates; arrivals
 * with `seq < expectedNextSeq` AND not yet applied are buffered as
 * "fill the gap". When a gap fills the projection drains the buffer in
 * canonical seq order. The only true drops are exact-`(thread_id, seq)`
 * duplicates of an applied envelope (`metrics.duplicates`) and arrivals
 * after `turn_completed` on the same thread
 * (`metrics.droppedAfterTurnCompleted`). `metrics.outOfOrder` counts
 * buffered-then-drained envelopes (back-compat name; not dropped).
 *
 * Pure module: no imports from `thread-store` and (post-γ-6)
 * `message-store` no longer exists.
 *
 * **`turn_completed` barrier**: the projection ignores trailing
 * envelopes after `turn_completed` on a `thread_id` and bumps
 * `droppedAfterTurnCompleted`. The bridge re-syncs the connection.
 *
 * **Referential stability (codex BLOCK 4)**: top-level `project()`
 * memoizes by input-array identity (same `envelopes` ref ⇒ same
 * `ChatViewModel` ref). Per-thread `ThreadView` caching is keyed on
 * `(appliedCount, lastSeq)`: when a thread's contributing envelopes
 * haven't changed across distinct `project()` calls, the projection
 * returns the same `ThreadView` reference. This is the simpler
 * variant the brief authorised — a future iteration may switch to a
 * structural hash when callers need finer-grained reuse.
 */

import type {
  Envelope,
  EnvelopeTokenUsage,
  EnvelopeToolEndStatus,
  FileRef,
  MessageMeta,
  Payload,
} from "../runtime/ui-protocol-types";

// ─── ChatViewModel shape ───────────────────────────────────────────────────

export interface UserView {
  /** First seq in this thread; stable identity for the row. */
  seq: number;
  /** Reflected from `Envelope.client_message_id` on the user-message-
   *  rooted envelope. The projection never consults this for identity;
   *  γ-4's `<GhostBubble>` overlay uses it to match-and-unmount. */
  client_message_id?: string;
  /** User-typed text from a `user_message` envelope. Empty until a
   *  `user_message` envelope has been observed. */
  text: string;
  /** File attachments from a `user_message` envelope. */
  files: ReadonlyArray<FileRef>;
}

export interface AssistantView {
  text: string;
  meta: MessageMeta | null;
  persisted: boolean;
}

export interface ToolCallView {
  tool_call_id: string;
  name: string;
  progress: ReadonlyArray<string>;
  status: EnvelopeToolEndStatus | null;
  error: string | null;
}

export interface FileView {
  seq: number;
  path: string;
  mime: string;
  size_bytes: number;
}

export interface ThreadView {
  thread_id: string;
  user: UserView | null;
  assistant: AssistantView | null;
  toolCalls: ReadonlyArray<ToolCallView>;
  files: ReadonlyArray<FileView>;
  completed: boolean;
  tokenUsage: EnvelopeTokenUsage | null;
}

export interface ChatViewModel {
  threads: ReadonlyArray<ThreadView>;
}

// ─── Projection metrics ─────────────────────────────────────────────────

export interface ProjectionMetrics {
  /** Exact `(thread_id, seq)` collision of an already-applied envelope. */
  duplicates: number;
  /** Envelopes ignored because they arrived after `turn_completed`. */
  droppedAfterTurnCompleted: number;
  /** Envelopes that arrived out of canonical seq order and were
   *  buffered until the gap filled (NOT dropped — eventually applied). */
  outOfOrder: number;
}

export interface ProjectionResult {
  view: ChatViewModel;
  metrics: ProjectionMetrics;
}

// ─── Memoization (codex BLOCK 4) ───────────────────────────────────────────

const projectionCache = new WeakMap<
  ReadonlyArray<Envelope>,
  ProjectionResult
>();

// Per-thread ThreadView cache keyed on (appliedCount, lastSeq). When
// a thread_id produces the same tuple across distinct projections, we
// return the same ThreadView ref. Bounded by the number of distinct
// thread_ids observed in the process lifetime.
const threadViewCache = new Map<
  string,
  { count: number; lastSeq: number; view: ThreadView }
>();

/** Test-only: drop the per-thread cache. Tests that re-use the same
 *  `thread_id` across cases need the cache cleared in `beforeEach` so
 *  cross-test bleed doesn't return a stale ThreadView reference. */
export function __resetProjectionCacheForTesting(): void {
  threadViewCache.clear();
  // projectionCache is a WeakMap keyed on input identity; unrelated
  // tests can't collide there, so no clear required.
}

// ─── Projection ────────────────────────────────────────────────────────────

export function project(envelopes: ReadonlyArray<Envelope>): ChatViewModel {
  return projectWithMetrics(envelopes).view;
}

export function projectWithMetrics(
  envelopes: ReadonlyArray<Envelope>,
): ProjectionResult {
  const cached = projectionCache.get(envelopes);
  if (cached) return cached;
  const computed = computeProjection(envelopes);
  projectionCache.set(envelopes, computed);
  return computed;
}

function computeProjection(
  envelopes: ReadonlyArray<Envelope>,
): ProjectionResult {
  interface ThreadAcc {
    thread_id: string;
    user: MutableUserView | null;
    assistantText: string;
    assistantMeta: MessageMeta | null;
    assistantPersisted: boolean;
    assistantSeen: boolean;
    toolOrder: string[];
    tools: Map<string, MutableToolCall>;
    files: FileView[];
    completed: boolean;
    tokenUsage: EnvelopeTokenUsage | null;
    seenSeqs: Set<number>;
    lastSeq: number; // sentinel: -1
    expectedNextSeq: number; // = lastSeq + 1
    pendingByGap: Map<number, Envelope>;
    seenUserMessage: boolean;
    /** Envelopes APPLIED to this thread (excludes ignored dups /
     *  dropped-after-completed). Used by the per-thread view cache. */
    appliedCount: number;
  }
  interface MutableUserView {
    seq: number;
    client_message_id?: string;
    text: string;
    files: FileRef[];
  }
  interface MutableToolCall {
    tool_call_id: string;
    name: string;
    progress: string[];
    status: EnvelopeToolEndStatus | null;
    error: string | null;
  }

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
      expectedNextSeq: 0,
      pendingByGap: new Map(),
      seenUserMessage: false,
      appliedCount: 0,
    };
    threads.set(thread_id, fresh);
    threadOrder.push(thread_id);
    return fresh;
  };

  function applyEnvelope(thread: ThreadAcc, env: Envelope): void {
    thread.seenSeqs.add(env.seq);
    if (env.seq > thread.lastSeq) {
      thread.lastSeq = env.seq;
    }
    thread.expectedNextSeq = thread.lastSeq + 1;
    thread.appliedCount += 1;

    // Capture user identity from the FIRST envelope we apply in
    // canonical order. Thread membership is determined exclusively by
    // `(thread_id, seq)` (M9-γ-5, issue #842). The cmid is stored only
    // so γ-4's GhostBubble overlay can match its server reflection and
    // unmount; the projection itself does NOT depend on it for
    // identity. Text + files come exclusively from a user_message
    // payload via applyPayload.
    if (thread.user === null) {
      thread.user = {
        seq: env.seq,
        ...(env.client_message_id !== undefined
          ? { client_message_id: env.client_message_id }
          : {}),
        text: "",
        files: [],
      };
    }

    applyPayload(thread, env.payload);
  }

  function drainPending(thread: ThreadAcc): void {
    while (
      !thread.completed &&
      thread.pendingByGap.has(thread.expectedNextSeq)
    ) {
      const next = thread.pendingByGap.get(thread.expectedNextSeq)!;
      thread.pendingByGap.delete(thread.expectedNextSeq);
      applyEnvelope(thread, next);
    }
  }

  for (const env of envelopes) {
    const thread = getThread(env.thread_id);

    // True duplicate of an already-applied (thread_id, seq).
    if (thread.seenSeqs.has(env.seq)) {
      duplicates += 1;
      continue;
    }

    // Hard barrier.
    if (thread.completed) {
      droppedAfterTurnCompleted += 1;
      continue;
    }

    // In-order arrival.
    if (env.seq === thread.expectedNextSeq) {
      applyEnvelope(thread, env);
      drainPending(thread);
      continue;
    }

    // Future arrival (gap above expected): buffer.
    if (env.seq > thread.expectedNextSeq) {
      if (thread.pendingByGap.has(env.seq)) {
        duplicates += 1;
        continue;
      }
      thread.pendingByGap.set(env.seq, env);
      outOfOrder += 1;
      continue;
    }

    // Late fill (env.seq < expectedNextSeq, not yet seen): buffer +
    // drain. Codex BLOCK 1: don't drop — buffer for canonical replay.
    thread.pendingByGap.set(env.seq, env);
    outOfOrder += 1;
    drainPending(thread);
  }

  // Build immutable views with per-thread reference stability.
  const threadViews: ThreadView[] = threadOrder.map((thread_id) => {
    const acc = threads.get(thread_id)!;

    const cached = threadViewCache.get(thread_id);
    if (
      cached &&
      cached.count === acc.appliedCount &&
      cached.lastSeq === acc.lastSeq
    ) {
      return cached.view;
    }

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
    const userView: UserView | null = acc.user
      ? {
          seq: acc.user.seq,
          ...(acc.user.client_message_id !== undefined
            ? { client_message_id: acc.user.client_message_id }
            : {}),
          text: acc.user.text,
          files: acc.user.files.slice(),
        }
      : null;
    const view: ThreadView = {
      thread_id: acc.thread_id,
      user: userView,
      assistant,
      toolCalls,
      files: acc.files.slice(),
      completed: acc.completed,
      tokenUsage: acc.tokenUsage,
    };
    threadViewCache.set(thread_id, {
      count: acc.appliedCount,
      lastSeq: acc.lastSeq,
      view,
    });
    return view;
  });

  return {
    view: { threads: threadViews },
    metrics: { duplicates, droppedAfterTurnCompleted, outOfOrder },
  };

  // ── inner: payload dispatch ───────────────────────────────────────────
  function applyPayload(thread: ThreadAcc, payload: Payload): void {
    switch (payload.type) {
      case "user_message": {
        // Codex BLOCK 3: populate UserView.text + files from the
        // user_message payload. First-seen wins per thread.
        if (!thread.user) {
          thread.user = {
            seq: thread.lastSeq,
            text: payload.data.text,
            files: payload.data.files.slice(),
          };
        } else if (!thread.seenUserMessage) {
          thread.user.text = payload.data.text;
          thread.user.files = payload.data.files.slice();
        }
        thread.seenUserMessage = true;
        return;
      }
      case "assistant_delta": {
        thread.assistantSeen = true;
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
        if (thread.tools.has(id)) return;
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
        thread.files.push({
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
        const _exhaustive: never = payload;
        void _exhaustive;
        return;
      }
    }
  }
}
