/**
 * M9-γ-3: Projection-mode store wrapper around γ-2's pure `project()` fn.
 *
 * Spec: `api/OCTOS_UI_PROTOCOL_V1_SPEC_2026-04-24.md` § 14 (M9-γ Envelope).
 * ADR:  `docs/M9-GAMMA-SERVER-PROJECTION-ADR.md` (PR #830).
 * γ-2:  `src/store/projection.ts` (PR #93, the pure projection function).
 * Issue: octos-org/octos#840.
 *
 * Behind the `projection_v1` feature flag (window.localStorage
 * `octos_projection_v1` === "1"), `ThreadStore` translates every legacy
 * mutation entry point into an `Envelope` and ingests it here. This
 * module owns the committed envelope log and exposes the projected
 * `ChatViewModel` for projection-only tests / future renderers.
 *
 * Intentional split from `thread-store.ts`:
 *   - The thread-store stays the migration-time facade (legacy reducer
 *     remains the source of truth for `getThreads()` so 191 existing
 *     tests pass under both flag states).
 *   - This store accumulates the committed envelope log and provides
 *     the projection-mode read surface for new tests + γ-4's optimistic
 *     overlay + γ-5's full cutover.
 *
 * Single mutation entry point: `ingest(envelope)`. Identity is
 * `(thread_id, seq)`.
 *
 * Sessions are addressed by an opaque "store key" — the same string
 * `thread-store.ts` uses internally (`sessionId` or `sessionId#topic`).
 * Keeping the addressing space identical avoids a (sessionId, topic)
 * round-trip on every dual-write hot-path call.
 *
 * ─── Seq policy (gap-buffer canonical) ───────────────────────────────────
 *
 * The shim mints client-side seqs when the caller has no server seq
 * (streamed deltas, in-flight tool starts, etc.). The shim's seqs are
 * 0-based per-thread monotonic — matching the projection's gap-buffer
 * `expectedNextSeq=0` initialization. Server-issued seqs (historySeq /
 * committedSeq) flow through `ingest()` with the server's own seq value;
 * the projection's gap-buffer drains in canonical order regardless of
 * arrival order. Identity is `(thread_id, seq)`; same-seq arrivals are
 * deduplicated, gap-buffered fills drain when the gap closes.
 */

import {
  __resetProjectionCacheForTesting,
  project,
  projectWithMetrics,
} from "./projection";
import type { ChatViewModel, ProjectionMetrics } from "./projection";
import type { Envelope } from "../runtime/ui-protocol-types";

// ─── Feature flag ──────────────────────────────────────────────────────────

/** localStorage key gating projection-mode dual-writes. Production
 *  default is OFF; tests flip the flag in their setup. */
const PROJECTION_V1_FLAG_KEY = "octos_projection_v1";

/** Cached snapshot of the flag's value on first read. The flag is
 *  intentionally locked in at first read so a mid-session flip can't
 *  start the projection log from the next shimmed event with no prior
 *  envelope history (codex round-1 BLOCK 5). A subsequent flip is a
 *  one-shot `console.warn` and ignored until reload. */
let cachedProjectionV1Enabled: boolean | null = null;
let warnedAboutMidSessionChange = false;

function readFlagFromStorage(): boolean {
  try {
    if (typeof globalThis === "undefined") return false;
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return false;
    return ls.getItem(PROJECTION_V1_FLAG_KEY) === "1";
  } catch {
    // Some jsdom configurations throw on `localStorage` access (security
    // origin checks). Treat unreachable storage as flag-off.
    return false;
  }
}

/** Read the projection-mode flag. Cached on first call so a mid-session
 *  flip can't start the projection log mid-stream. Subsequent flag
 *  changes log a one-shot warning and are otherwise ignored until the
 *  next reload. Tests reset the cache via `__setProjectionV1ForTests`. */
export function isProjectionV1Enabled(): boolean {
  if (cachedProjectionV1Enabled !== null) {
    // Detect a mid-session flip and warn (once). The cache wins; the
    // observed flag value at first read is the source of truth for the
    // rest of the session.
    if (!warnedAboutMidSessionChange) {
      const live = readFlagFromStorage();
      if (live !== cachedProjectionV1Enabled) {
        warnedAboutMidSessionChange = true;
        console.warn(
          "[octos] octos_projection_v1 changed mid-session; the new " +
            "value is ignored until reload to avoid starting the " +
            "projection log mid-stream.",
        );
      }
    }
    return cachedProjectionV1Enabled;
  }
  cachedProjectionV1Enabled = readFlagFromStorage();
  return cachedProjectionV1Enabled;
}

/** Test helper: flip the flag in the current jsdom origin AND reset the
 *  cache so the next `isProjectionV1Enabled()` call re-reads it. Without
 *  the cache reset, vitest-level flips would all see the value latched
 *  from the very first read in the worker process. */
export function __setProjectionV1ForTests(enabled: boolean): void {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) {
      cachedProjectionV1Enabled = null;
      warnedAboutMidSessionChange = false;
      return;
    }
    if (enabled) ls.setItem(PROJECTION_V1_FLAG_KEY, "1");
    else ls.removeItem(PROJECTION_V1_FLAG_KEY);
  } catch {
    // No-op when storage is unavailable.
  }
  cachedProjectionV1Enabled = null;
  warnedAboutMidSessionChange = false;
}

// ─── Internal state ────────────────────────────────────────────────────────

/** Committed envelope log per session storeKey. Append-only. */
const envelopesByKey = new Map<string, Envelope[]>();

/** Per-(storeKey, thread) monotonic counter for shim-minted seqs.
 *  Counter advances by 1 on each call; first value returned is 0,
 *  matching projection's `expectedNextSeq=0` initialization so the very
 *  first envelope on a thread applies in-order under gap-buffer
 *  semantics. */
const seqCountersByKey = new Map<string, Map<string, number>>();

// ─── Subscriber + cmid index (M9-γ-4 codex BLOCKs 1 & 5) ───────────────────
//
// BLOCK 1 (settle ordering): subscribers fire AFTER `ingest()` appends to
// the log, so a `<GhostBubble>` subscribing here is guaranteed to see the
// envelope in `getProjection()`. Production thread-store mutators usually
// call `notify()` BEFORE the projection dual-write, so subscribing to
// `ThreadStore.subscribe` alone could leave a ghost waiting for an
// unrelated later notify (or hit the 30s timeout). The projection-store's
// own `notify()` closes that race.
//
// BLOCK 5 (O(1) cmid lookup): `ingest()` records every observed
// `(storeKey, client_message_id) → thread_id` mapping. `hasCmid()` is
// O(1) instead of `getProjection()` followed by a full thread scan on
// every notify.

/** Listeners registered with `subscribe()`. Fired by `ingest()`. */
const listeners = new Set<() => void>();

/** Per-storeKey index of `client_message_id → thread_id` for O(1) ghost
 *  match lookups. Populated as a side effect of `ingest()` when an
 *  envelope carries a `client_message_id`. The mapping is monotonic:
 *  the first envelope to introduce a cmid wins; later envelopes for the
 *  same thread can omit the cmid without unsetting the entry. */
const cmidToThreadByKey = new Map<string, Map<string, string>>();

function recordCmidIfPresent(storeKey: string, envelope: Envelope): void {
  const cmid = envelope.client_message_id;
  if (cmid === undefined) return;
  let perKey = cmidToThreadByKey.get(storeKey);
  if (!perKey) {
    perKey = new Map();
    cmidToThreadByKey.set(storeKey, perKey);
  }
  // First-write-wins: do not overwrite an existing mapping. The
  // projection's identity is `(thread_id, seq)`, but in practice a
  // single cmid only ever roots one thread, so a re-emission is benign.
  if (!perKey.has(cmid)) {
    perKey.set(cmid, envelope.thread_id);
  }
}

function notifyProjectionListeners(): void {
  // Snapshot the listener set so a synchronous unsubscribe inside one
  // handler doesn't perturb iteration of the others.
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      // A faulty listener must not break the ingest path; log and
      // continue. We don't have a structured logger here — match the
      // thread-store style and keep it console-best-effort.
      console.error("projection-store listener threw", e);
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Synthesize the next client-side seq for a thread. Returns a
 * non-negative integer (0, 1, 2, …) — per-thread monotonic, not
 * `Date.now()`-based, so re-projecting the committed log is
 * deterministic. The projection dedupes on `(thread_id, seq)`; the shim
 * caller is responsible for not minting a synthetic seq when the server
 * is going to assign its own (the migration shim only mints for
 * pre-persistence in-flight events).
 */
export function nextSeq(storeKey: string, threadId: string): number {
  let perThread = seqCountersByKey.get(storeKey);
  if (!perThread) {
    perThread = new Map();
    seqCountersByKey.set(storeKey, perThread);
  }
  const next = perThread.get(threadId) ?? 0;
  perThread.set(threadId, next + 1);
  return next;
}

/** The single mutation entry point. Append the envelope to the
 *  committed log, update the cmid index, and fan out to subscribers.
 *
 *  Order matters: log append → cmid index → notify. Subscribers (e.g.
 *  the M9-γ-4 `<GhostBubble>`) are guaranteed to see the envelope via
 *  `getProjection()` AND `hasCmid()` by the time they run. This closes
 *  the BLOCK 1 race where the legacy thread-store called `notify()`
 *  BEFORE its projection dual-write.
 *
 *  M9-γ-5 (issue #842): projection identity is `(thread_id, seq)` ONLY.
 *  The cmid is carried on the user-rooted envelope as a passenger field
 *  so γ-4's GhostBubble overlay can match a server reflection and
 *  unmount; the projection's own dedup does NOT consult it. The
 *  cmidToThreadByKey index above is a render-side helper, not part of
 *  the canonical projection state.
 *
 *  The projection dedupes / orders / barriers — this function does NOT
 *  validate the envelope's seq nor enforce monotonicity; that's the
 *  projection's job (and the bridge's, in production). */
export function ingest(storeKey: string, envelope: Envelope): void {
  let log = envelopesByKey.get(storeKey);
  if (!log) {
    log = [];
    envelopesByKey.set(storeKey, log);
  }
  log.push(envelope);
  recordCmidIfPresent(storeKey, envelope);
  notifyProjectionListeners();
}

/** Subscribe to projection-store ingests. The listener fires AFTER
 *  every `ingest()` once the envelope is committed to the log AND the
 *  cmid index is updated — so subscribers can synchronously call
 *  `getProjection(storeKey)` / `hasCmid(...)` and see the new state.
 *
 *  Returns an unsubscribe function. Idempotent: calling it twice is a
 *  no-op. Listeners are stored in an insertion-ordered `Set`, so the
 *  notify order is the registration order.
 *
 *  M9-γ-4 BLOCK 1 fix — see the module-level comment block above. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** O(1) lookup: has any envelope with this `client_message_id` been
 *  ingested for `storeKey`? Backed by the cmid index populated by
 *  `ingest()`.
 *
 *  Replaces the per-notify `getProjection().threads.find(...)` scan
 *  GhostBubble used to do (BLOCK 5 in the codex review). */
export function hasCmid(storeKey: string, clientMessageId: string): boolean {
  const perKey = cmidToThreadByKey.get(storeKey);
  if (!perKey) return false;
  return perKey.has(clientMessageId);
}

/** O(1) lookup: which `thread_id` did this `client_message_id` first
 *  attach to? Returns `undefined` if no envelope carrying the cmid has
 *  been ingested. Useful for routing later mutations back to the same
 *  thread bucket without walking the projection. */
export function threadIdForCmid(
  storeKey: string,
  clientMessageId: string,
): string | undefined {
  return cmidToThreadByKey.get(storeKey)?.get(clientMessageId);
}

/** Get the committed envelope log for a session. Returned as a
 *  read-only view; callers must NOT mutate. Useful for projection-only
 *  tests that want to assert on the raw log shape. */
export function getEnvelopes(storeKey: string): ReadonlyArray<Envelope> {
  return envelopesByKey.get(storeKey) ?? [];
}

/** Compute and return the projected `ChatViewModel` for a session. */
export function getProjection(storeKey: string): ChatViewModel {
  return project(getEnvelopes(storeKey));
}

/** Variant that surfaces metrics counters alongside the view. */
export function getProjectionWithMetrics(
  storeKey: string,
): { view: ChatViewModel; metrics: ProjectionMetrics } {
  return projectWithMetrics(getEnvelopes(storeKey));
}

/** Drop all projection state for a session (envelope log + counters
 *  + cmid index). Mirrors `thread-store.clearSession` semantics: a
 *  topic-less call sweeps the bare key AND every topic-suffixed
 *  variant. */
export function clearProjection(sessionId: string, topic?: string): void {
  const trimmedTopic = topic?.trim();
  if (trimmedTopic) {
    const key = `${sessionId}#${trimmedTopic}`;
    envelopesByKey.delete(key);
    seqCountersByKey.delete(key);
    cmidToThreadByKey.delete(key);
    return;
  }
  for (const k of [...envelopesByKey.keys()]) {
    if (k === sessionId || k.startsWith(`${sessionId}#`)) {
      envelopesByKey.delete(k);
    }
  }
  for (const k of [...seqCountersByKey.keys()]) {
    if (k === sessionId || k.startsWith(`${sessionId}#`)) {
      seqCountersByKey.delete(k);
    }
  }
  for (const k of [...cmidToThreadByKey.keys()]) {
    if (k === sessionId || k.startsWith(`${sessionId}#`)) {
      cmidToThreadByKey.delete(k);
    }
  }
}

/** Build the shared store-key string. Mirrors `thread-store`'s
 *  internal `storeKey` so dual-writes target the same bucket. */
export function projectionStoreKey(
  sessionId: string,
  topic?: string,
): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
}

/** Test-only helper: reset all projection-store state, including the
 *  pure-function projection's per-thread ThreadView cache. The cache
 *  lives in `projection.ts` module scope; without clearing it, a thread
 *  whose `(appliedCount, lastSeq)` matches a stale entry from a previous
 *  test would return the stale view. */
export function __resetProjectionForTests(): void {
  envelopesByKey.clear();
  seqCountersByKey.clear();
  cmidToThreadByKey.clear();
  listeners.clear();
  __resetProjectionCacheForTesting();
  __setProjectionV1ForTests(false);
}
