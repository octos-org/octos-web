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
 * `(thread_id, seq)`. The shim synthesizes client-side seqs from a
 * per-thread monotonic counter so the projection (which dedupes on
 * `(thread_id, seq)`) sees deterministic ordering even before the
 * server's authoritative seq lands.
 *
 * Sessions are addressed by an opaque "store key" — the same string
 * `thread-store.ts` uses internally (`sessionId` or `sessionId#topic`).
 * Keeping the addressing space identical avoids a (sessionId, topic)
 * round-trip on every dual-write hot-path call.
 */

import { project, projectWithMetrics } from "./projection";
import type { ChatViewModel, ProjectionMetrics } from "./projection";
import type { Envelope } from "../runtime/ui-protocol-types";

// ─── Feature flag ──────────────────────────────────────────────────────────

/** localStorage key gating projection-mode dual-writes. Production
 *  default is OFF; tests flip the flag in their setup. */
const PROJECTION_V1_FLAG_KEY = "octos_projection_v1";

/** Read the projection-mode flag. Safe in non-browser test envs (jsdom
 *  exposes `localStorage`; Node doesn't — the access is wrapped). */
export function isProjectionV1Enabled(): boolean {
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

/** Test helper: flip the flag in the current jsdom origin. */
export function __setProjectionV1ForTests(enabled: boolean): void {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return;
    if (enabled) ls.setItem(PROJECTION_V1_FLAG_KEY, "1");
    else ls.removeItem(PROJECTION_V1_FLAG_KEY);
  } catch {
    // No-op when storage is unavailable.
  }
}

// ─── Internal state ────────────────────────────────────────────────────────

/** Committed envelope log per session storeKey. Append-only. */
const envelopesByKey = new Map<string, Envelope[]>();

/** Per-(storeKey, thread) monotonic seq counter. Used by the shim when
 *  no server-assigned seq is available — the projection dedupes by
 *  `(thread_id, seq)` so deterministic per-thread ordering is what
 *  matters, not the absolute integer value. */
const seqCountersByKey = new Map<string, Map<string, number>>();

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Synthesize the next client-side seq for a thread. Per-thread
 * monotonic (NOT `Date.now()` — must be deterministic for
 * re-projection).
 *
 * The server's authoritative seq arrives separately on a real ingest
 * path; the projection dedupes by exact `(thread_id, seq)` match. As
 * long as our shim's seqs are unique within the thread (which a
 * monotonic counter guarantees), the projection produces a stable view.
 *
 * Counter is 1-based so that `seq >= 0` checks (the projection treats
 * `lastSeq = -1` as the initial sentinel) admit the first envelope.
 */
export function nextSeq(storeKey: string, threadId: string): number {
  let perThread = seqCountersByKey.get(storeKey);
  if (!perThread) {
    perThread = new Map();
    seqCountersByKey.set(storeKey, perThread);
  }
  const next = (perThread.get(threadId) ?? 0) + 1;
  perThread.set(threadId, next);
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

/** Test-only helper: reset all projection-store state. */
export function __resetProjectionForTests(): void {
  envelopesByKey.clear();
  seqCountersByKey.clear();
  __setProjectionV1ForTests(false);
}
