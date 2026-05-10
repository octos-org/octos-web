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
 *  committed log. The projection dedupes / orders / barriers — this
 *  function does NOT validate the envelope's seq nor enforce
 *  monotonicity; that's the projection's job (and the bridge's, in
 *  production). */
export function ingest(storeKey: string, envelope: Envelope): void {
  let log = envelopesByKey.get(storeKey);
  if (!log) {
    log = [];
    envelopesByKey.set(storeKey, log);
  }
  log.push(envelope);
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

/** Drop all projection state for a session (envelope log + counters).
 *  Mirrors `thread-store.clearSession` semantics: a topic-less call
 *  sweeps the bare key AND every topic-suffixed variant. */
export function clearProjection(sessionId: string, topic?: string): void {
  const trimmedTopic = topic?.trim();
  if (trimmedTopic) {
    const key = `${sessionId}#${trimmedTopic}`;
    envelopesByKey.delete(key);
    seqCountersByKey.delete(key);
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
  __resetProjectionCacheForTesting();
  __setProjectionV1ForTests(false);
}
