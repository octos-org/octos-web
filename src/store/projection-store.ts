/**
 * Canonical v2 projection store.
 *
 * This is the only store that accepts `projection.envelope.v2` frames. It is
 * deliberately independent from ThreadStore: legacy reducers remain a
 * fallback for servers that do not negotiate v2, but they never dual-write
 * into this state.
 */

import {
  __resetProjectionCacheForTesting,
  projectWithMetrics,
} from "./projection";
import type { ChatViewModel, ProjectionMetrics } from "./projection";
import type {
  ProjectionEnvelopeV2,
  ProjectionEnvelopeV2Cursor,
} from "../runtime/projection-envelope-v2";

export const PROJECTION_ENVELOPE_V2_FEATURE = "projection.envelope.v2";

/** `pending` is the pre-negotiation state. It deliberately renders neither
 * store so a new server cannot flash a legacy history before it confirms
 * `projection.envelope.v2`; an old server switches to `legacy` on its ack. */
export type ProjectionMode = "pending" | "legacy" | "v2";

export interface ProjectionIngestResult {
  accepted: boolean;
  duplicate: boolean;
  gapDetected: boolean;
}

interface ProjectionState {
  mode: ProjectionMode;
  threadOrder: string[];
  appliedByThread: Map<string, Map<number, ProjectionEnvelopeV2>>;
  expectedByThread: Map<string, number>;
  pendingByThread: Map<string, Map<number, ProjectionEnvelopeV2>>;
  /** Exact canonical-user mappings only; assistant frames never settle ghosts. */
  cmidToThread: Map<string, string>;
  /** Turn identity is explicit in v2; never infer its cmid from a thread's
   * first user row because a server may retain more than one turn per thread. */
  turnToClientMessageId: Map<string, string>;
  /** Last *globally contiguous* ledger position. This is the only cursor
   * allowed to drive reconnect `after`; per-thread sequence continuity is
   * insufficient because another thread may occupy a missing ledger entry. */
  watermark: ProjectionEnvelopeV2Cursor | null;
  /** Established by a hydrate snapshot watermark. Before that snapshot, a
   * live frame's cursor cannot prove that earlier ledger entries were seen. */
  nextLedgerCursorSeq: number | null;
  /** Accepted frames beyond a missing global ledger coordinate. Their thread
   * projections may still be useful immediately, but reconnect must remain
   * pinned below the hole until snapshot recovery closes it. */
  pendingLedgerCursors: Map<number, ProjectionEnvelopeV2Cursor>;
  ledgerStreamMismatch: boolean;
  hydrating: boolean;
  hydrationWatermark: ProjectionEnvelopeV2Cursor | null;
  bufferedLive: ProjectionEnvelopeV2[];
  rehydrateNeeded: boolean;
  version: number;
  cachedProjection?: { version: number; view: ChatViewModel; metrics: ProjectionMetrics };
}

const states = new Map<string, ProjectionState>();
const listeners = new Set<() => void>();
const admittedEnvelopeListeners = new Set<
  (storeKey: string, envelope: ProjectionEnvelopeV2) => void
>();
const rehydrateListeners = new Set<(storeKey: string, watermark: ProjectionEnvelopeV2Cursor | null) => void>();
const persistentRehydrateListeners = new Set<
  (storeKey: string, watermark: ProjectionEnvelopeV2Cursor | null) => void
>();

function freshState(): ProjectionState {
  return {
    // Bare render fixtures and non-bridge embeddings retain the historic
    // fallback. RuntimeWithSession moves real mounted scopes to `pending`
    // synchronously before passive history effects can load legacy content.
    mode: "legacy",
    threadOrder: [],
    appliedByThread: new Map(),
    expectedByThread: new Map(),
    pendingByThread: new Map(),
    cmidToThread: new Map(),
    turnToClientMessageId: new Map(),
    watermark: null,
    nextLedgerCursorSeq: null,
    pendingLedgerCursors: new Map(),
    ledgerStreamMismatch: false,
    hydrating: false,
    hydrationWatermark: null,
    bufferedLive: [],
    rehydrateNeeded: false,
    version: 0,
  };
}

function stateFor(storeKey: string): ProjectionState {
  let state = states.get(storeKey);
  if (!state) {
    state = freshState();
    states.set(storeKey, state);
  }
  return state;
}

function touch(state: ProjectionState): void {
  state.version += 1;
  state.cachedProjection = undefined;
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error("projection-store listener threw", error);
    }
  }
}

/** Notify consumers after a canonical envelope has actually entered the
 * contiguous projection. This includes frames drained from a per-thread gap
 * and live frames replayed after an atomic snapshot install. */
function notifyEnvelopeAdmitted(
  storeKey: string,
  envelope: ProjectionEnvelopeV2,
): void {
  for (const listener of [...admittedEnvelopeListeners]) {
    try {
      listener(storeKey, envelope);
    } catch (error) {
      console.error("projection-store admitted-envelope listener threw", error);
    }
  }
}

function requestRehydrate(storeKey: string, state: ProjectionState): void {
  if (state.rehydrateNeeded) return;
  state.rehydrateNeeded = true;
  // A snapshot is already being installed. Remember that it was incomplete,
  // but do not recursively start another hydrate before the current atomic
  // replacement has replayed its live buffer.
  if (state.hydrating) return;
  for (const listener of [
    ...rehydrateListeners,
    ...persistentRehydrateListeners,
  ]) {
    try {
      listener(storeKey, state.watermark);
    } catch (error) {
      console.error("projection-store rehydrate listener threw", error);
    }
  }
}

function compareCursor(
  left: ProjectionEnvelopeV2Cursor,
  right: ProjectionEnvelopeV2Cursor,
): number | null {
  if (left.stream !== right.stream) return null;
  return left.seq - right.seq;
}

function hasThreadGaps(state: ProjectionState): boolean {
  for (const pending of state.pendingByThread.values()) {
    if (pending.size > 0) return true;
  }
  return false;
}

function hasGaps(state: ProjectionState): boolean {
  return (
    hasThreadGaps(state) ||
    state.pendingLedgerCursors.size > 0 ||
    state.ledgerStreamMismatch
  );
}

function seedLedgerWatermark(
  state: ProjectionState,
  watermark: ProjectionEnvelopeV2Cursor,
): void {
  state.watermark = { ...watermark };
  state.nextLedgerCursorSeq = watermark.seq + 1;
  state.pendingLedgerCursors.clear();
  state.ledgerStreamMismatch = false;
}

/** Observe an already-admitted envelope on the *global* ledger. Frames are
 * admitted to their own thread by `(thread_id, seq)`, but that does not prove
 * another thread's cursor was received. Only advance a reconnect watermark
 * through contiguous `UiCursor.seq` values after a snapshot established the
 * starting coordinate. */
function observeLedgerCursor(
  storeKey: string,
  state: ProjectionState,
  cursor: ProjectionEnvelopeV2Cursor | undefined,
): void {
  if (!cursor || !state.watermark) return;
  if (cursor.stream !== state.watermark.stream) {
    state.ledgerStreamMismatch = true;
    requestRehydrate(storeKey, state);
    return;
  }
  if (cursor.seq <= state.watermark.seq) return;

  const expected = state.nextLedgerCursorSeq ?? state.watermark.seq + 1;
  if (cursor.seq > expected) {
    state.pendingLedgerCursors.set(cursor.seq, { ...cursor });
    requestRehydrate(storeKey, state);
    return;
  }

  state.watermark = { ...cursor };
  let next = cursor.seq + 1;
  while (state.pendingLedgerCursors.has(next)) {
    const queued = state.pendingLedgerCursors.get(next)!;
    state.pendingLedgerCursors.delete(next);
    state.watermark = queued;
    next += 1;
  }
  state.nextLedgerCursorSeq = next;
}

function applyAccepted(
  storeKey: string,
  state: ProjectionState,
  envelope: ProjectionEnvelopeV2,
): void {
  let applied = state.appliedByThread.get(envelope.thread_id);
  if (!applied) {
    applied = new Map();
    state.appliedByThread.set(envelope.thread_id, applied);
    state.threadOrder.push(envelope.thread_id);
  }
  applied.set(envelope.seq, envelope);
  if (
    envelope.payload.type === "user_message" &&
    envelope.client_message_id !== undefined
  ) {
    state.cmidToThread.set(envelope.client_message_id, envelope.thread_id);
    state.turnToClientMessageId.set(
      envelope.turn_id,
      envelope.client_message_id,
    );
  }
  observeLedgerCursor(storeKey, state, envelope.cursor);
}

function ingestCanonical(
  storeKey: string,
  state: ProjectionState,
  envelope: ProjectionEnvelopeV2,
): ProjectionIngestResult {
  const applied = state.appliedByThread.get(envelope.thread_id);
  if (applied?.has(envelope.seq)) {
    return { accepted: false, duplicate: true, gapDetected: false };
  }
  const expected = state.expectedByThread.get(envelope.thread_id) ?? 1;
  if (envelope.seq < expected) {
    // Every seq below expected was admitted while draining a contiguous
    // prefix. Treat another copy as idempotent even if a bad snapshot did not
    // keep its original object instance.
    return { accepted: false, duplicate: true, gapDetected: false };
  }
  if (envelope.seq > expected) {
    let pending = state.pendingByThread.get(envelope.thread_id);
    if (!pending) {
      pending = new Map();
      state.pendingByThread.set(envelope.thread_id, pending);
    }
    if (pending.has(envelope.seq)) {
      return { accepted: false, duplicate: true, gapDetected: true };
    }
    pending.set(envelope.seq, envelope);
    requestRehydrate(storeKey, state);
    return { accepted: false, duplicate: false, gapDetected: true };
  }

  applyAccepted(storeKey, state, envelope);
  notifyEnvelopeAdmitted(storeKey, envelope);
  let next = expected + 1;
  const pending = state.pendingByThread.get(envelope.thread_id);
  while (pending?.has(next)) {
    const queued = pending.get(next)!;
    pending.delete(next);
    applyAccepted(storeKey, state, queued);
    notifyEnvelopeAdmitted(storeKey, queued);
    next += 1;
  }
  state.expectedByThread.set(envelope.thread_id, next);
  if (pending && pending.size === 0) state.pendingByThread.delete(envelope.thread_id);
  if (!hasGaps(state)) state.rehydrateNeeded = false;
  return { accepted: true, duplicate: false, gapDetected: false };
}

function cursorIsAfter(
  cursor: ProjectionEnvelopeV2Cursor | undefined,
  watermark: ProjectionEnvelopeV2Cursor | null,
): boolean {
  if (!cursor || !watermark) return true;
  const comparison = compareCursor(cursor, watermark);
  // Different streams cannot be ordered safely. Replay rather than dropping.
  return comparison === null || comparison > 0;
}

/** Frames already admitted (or gap-buffered) before `beginSnapshot` are
 * still live relative to a response whose ledger watermark predates them.
 * Keep them alongside the in-transition side buffer so snapshot replacement
 * never loses the small ACK→hydrate race or a pending gap-repair frame. */
function framesToPreserveAcrossSnapshot(state: ProjectionState): ProjectionEnvelopeV2[] {
  const byIdentity = new Map<string, ProjectionEnvelopeV2>();
  const add = (envelope: ProjectionEnvelopeV2) => {
    const identity = `${envelope.thread_id}\u0000${envelope.seq}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, envelope);
  };
  for (const applied of state.appliedByThread.values()) {
    for (const envelope of applied.values()) add(envelope);
  }
  for (const pending of state.pendingByThread.values()) {
    for (const envelope of pending.values()) add(envelope);
  }
  return [...byIdentity.values()];
}

function admittedFrames(state: ProjectionState): ProjectionEnvelopeV2[] {
  const frames: ProjectionEnvelopeV2[] = [];
  for (const applied of state.appliedByThread.values()) {
    frames.push(...applied.values());
  }
  return frames;
}

function resetCanonical(state: ProjectionState): void {
  state.threadOrder = [];
  state.appliedByThread.clear();
  state.expectedByThread.clear();
  state.pendingByThread.clear();
  state.cmidToThread.clear();
  state.turnToClientMessageId.clear();
  state.watermark = null;
  state.nextLedgerCursorSeq = null;
  state.pendingLedgerCursors.clear();
  state.ledgerStreamMismatch = false;
  state.rehydrateNeeded = false;
}

/** Enter the pre-negotiation state for a newly started bridge. Reconnects do
 * not call this: they retain the previously confirmed render mode while the
 * new socket waits for its own `session/open` acknowledgement. */
export function setProjectionV2Pending(
  sessionId: string,
  topic?: string,
): void {
  const state = stateFor(projectionStoreKey(sessionId, topic));
  if (state.mode === "pending") return;
  resetCanonical(state);
  state.hydrating = false;
  state.hydrationWatermark = null;
  state.bufferedLive = [];
  state.mode = "pending";
  touch(state);
  notify();
}

/** Server capability—not local storage—selects the final render path for a
 * scope after `session/open` has acknowledged it. */
export function setProjectionV2Enabled(
  sessionId: string,
  topic: string | undefined,
  enabled: boolean,
): void {
  const state = stateFor(projectionStoreKey(sessionId, topic));
  const next: ProjectionMode = enabled ? "v2" : "legacy";
  if (state.mode === next) return;
  // A later connection can negotiate an older server for the same scope.
  // Never retain a hidden canonical ledger across that boundary: should v2
  // be negotiated again, its hydrate is the only authoritative seed.
  if (next === "legacy") {
    resetCanonical(state);
    state.hydrating = false;
    state.hydrationWatermark = null;
    state.bufferedLive = [];
  }
  state.mode = next;
  touch(state);
  notify();
}

export function projectionMode(sessionId: string, topic?: string): ProjectionMode {
  return stateFor(projectionStoreKey(sessionId, topic)).mode;
}

export function isProjectionV2Enabled(sessionId: string, topic?: string): boolean {
  return projectionMode(sessionId, topic) === "v2";
}

export function isLegacyProjectionEnabled(sessionId: string, topic?: string): boolean {
  return projectionMode(sessionId, topic) === "legacy";
}

/** Canonical append. Identity is `(thread_id, seq)` and seq one is the
 * first legal event. A future event is buffered and requests rehydration. */
export function ingest(
  storeKey: string,
  envelope: ProjectionEnvelopeV2,
): ProjectionIngestResult {
  const state = stateFor(storeKey);
  if (state.hydrating) {
    state.bufferedLive.push(envelope);
    touch(state);
    notify();
    return { accepted: false, duplicate: false, gapDetected: false };
  }
  const result = ingestCanonical(storeKey, state, envelope);
  if (result.accepted || result.gapDetected) {
    touch(state);
    notify();
  }
  return result;
}

/** Begin an atomic snapshot transition. Live envelopes are retained in a
 * side buffer until `replaceSnapshot` installs the cursor watermark. */
export function beginSnapshot(
  storeKey: string,
  watermark: ProjectionEnvelopeV2Cursor | null = getWatermark(storeKey),
): boolean {
  const state = stateFor(storeKey);
  // A reconnect hydrate and a gap recovery can race into the same scope. The
  // first snapshot owns the live side buffer; resetting it here would discard
  // envelopes received while that snapshot was in flight.
  if (state.hydrating) return false;
  state.hydrating = true;
  state.hydrationWatermark = watermark ? { ...watermark } : null;
  state.bufferedLive = [];
  touch(state);
  notify();
  return true;
}

/** Replace the durable snapshot, then replay only live frames after its
 * ledger watermark. Per-thread seq is never used as a replay cursor. */
export function replaceSnapshot(
  storeKey: string,
  snapshot: ReadonlyArray<ProjectionEnvelopeV2>,
  watermark?: ProjectionEnvelopeV2Cursor | null,
): void {
  const state = stateFor(storeKey);
  // Include frames that landed just before the snapshot transition as well
  // as those buffered while it was in flight. A hydrate response is allowed
  // to be behind the latest live ledger cursor; replacing blindly would
  // otherwise erase that already-admitted tail.
  const buffered = [
    ...framesToPreserveAcrossSnapshot(state),
    ...state.bufferedLive,
  ];
  const effectiveWatermark = watermark ?? state.hydrationWatermark;
  resetCanonical(state);

  // Snapshot order is a transport detail. Admission restores canonical
  // per-thread order and catches a malformed/non-contiguous snapshot.
  for (const envelope of snapshot) {
    ingestCanonical(storeKey, state, envelope);
  }
  // A server snapshot watermark is trustworthy only when the admitted
  // snapshot is contiguous within each thread. (Global cursor continuity is
  // established by this watermark itself; a projection snapshot may omit
  // unrelated ledger entries.) Advancing across a known thread hole would
  // make the next reconnect ask the ledger to skip exactly the frame we still
  // need. In that case replay every buffered live frame (including one at
  // the snapshot cursor) and rehydrate again if the hole remains.
  const snapshotHasGap = hasThreadGaps(state);
  const replayWatermark = snapshotHasGap ? null : effectiveWatermark;
  if (effectiveWatermark && !snapshotHasGap) {
    seedLedgerWatermark(state, effectiveWatermark);
  }
  state.hydrating = false;
  state.hydrationWatermark = null;
  state.bufferedLive = [];
  state.rehydrateNeeded = false;

  for (const envelope of buffered) {
    if (cursorIsAfter(envelope.cursor, replayWatermark)) {
      ingestCanonical(storeKey, state, envelope);
    }
  }
  // A malformed snapshot may initially have a per-thread hole while the
  // live buffer carries its repair at or before the server watermark. Once
  // that repair closes the hole, the snapshot header becomes a safe global
  // baseline after all. Re-observe any already-admitted post-snapshot tail
  // so it can advance only through contiguous ledger coordinates.
  if (
    snapshotHasGap &&
    effectiveWatermark &&
    !hasThreadGaps(state) &&
    state.watermark === null
  ) {
    seedLedgerWatermark(state, effectiveWatermark);
    for (const envelope of admittedFrames(state)
      .filter((entry) => cursorIsAfter(entry.cursor, effectiveWatermark))
      .sort((left, right) => (left.cursor?.seq ?? 0) - (right.cursor?.seq ?? 0))) {
      observeLedgerCursor(storeKey, state, envelope.cursor);
    }
  }
  if (hasGaps(state)) requestRehydrate(storeKey, state);
  touch(state);
  notify();
}

/** End a hydrate when an older server has no v2 snapshot surface. Buffered
 * live frames remain safe because admission/dedup still uses `(thread, seq)`. */
export function finishSnapshotWithoutReplace(storeKey: string): void {
  const state = stateFor(storeKey);
  if (!state.hydrating) return;
  const buffered = state.bufferedLive.slice();
  const watermark = state.hydrationWatermark;
  state.hydrating = false;
  state.hydrationWatermark = null;
  state.bufferedLive = [];
  for (const envelope of buffered) {
    if (cursorIsAfter(envelope.cursor, watermark)) ingestCanonical(storeKey, state, envelope);
  }
  if (hasGaps(state)) requestRehydrate(storeKey, state);
  touch(state);
  notify();
}

export function hasRehydrateGap(storeKey: string): boolean {
  return stateFor(storeKey).rehydrateNeeded;
}

export function getWatermark(storeKey: string): ProjectionEnvelopeV2Cursor | null {
  const watermark = stateFor(storeKey).watermark;
  return watermark ? { ...watermark } : null;
}

export function getEnvelopes(storeKey: string): ReadonlyArray<ProjectionEnvelopeV2> {
  const state = stateFor(storeKey);
  const envelopes: ProjectionEnvelopeV2[] = [];
  for (const threadId of state.threadOrder) {
    const applied = state.appliedByThread.get(threadId);
    if (!applied) continue;
    envelopes.push(...[...applied.values()].sort((a, b) => a.seq - b.seq));
  }
  return envelopes;
}

export function getProjection(storeKey: string): ChatViewModel {
  return getProjectionWithMetrics(storeKey).view;
}

export function getProjectionWithMetrics(
  storeKey: string,
): { view: ChatViewModel; metrics: ProjectionMetrics } {
  const state = stateFor(storeKey);
  const cached = state.cachedProjection;
  if (cached && cached.version === state.version) {
    return { view: cached.view, metrics: cached.metrics };
  }
  const computed = projectWithMetrics(getEnvelopes(storeKey));
  state.cachedProjection = {
    version: state.version,
    view: computed.view,
    metrics: computed.metrics,
  };
  return computed;
}

/** Exact canonical-user lookup used by the optimistic overlay. */
export function hasCmid(storeKey: string, clientMessageId: string): boolean {
  return stateFor(storeKey).cmidToThread.has(clientMessageId);
}

export function threadIdForCmid(storeKey: string, clientMessageId: string): string | undefined {
  return stateFor(storeKey).cmidToThread.get(clientMessageId);
}

export function clientMessageIdForTurn(storeKey: string, turnId: string): string | undefined {
  return stateFor(storeKey).turnToClientMessageId.get(turnId);
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe to envelopes only once they are admitted to the canonical,
 * contiguous stream. Consumers that react to terminals use this rather than
 * raw WebSocket arrival so snapshot buffering cannot lose their signal. */
export function onEnvelopeAdmitted(
  listener: (storeKey: string, envelope: ProjectionEnvelopeV2) => void,
): () => void {
  admittedEnvelopeListeners.add(listener);
  return () => admittedEnvelopeListeners.delete(listener);
}

export function onRehydrateRequested(
  listener: (storeKey: string, watermark: ProjectionEnvelopeV2Cursor | null) => void,
  options: { persistent?: boolean } = {},
): () => void {
  const target = options.persistent
    ? persistentRehydrateListeners
    : rehydrateListeners;
  target.add(listener);
  return () => target.delete(listener);
}

/** Clear canonical content for one scope but retain negotiated mode. */
export function clearProjection(sessionId: string, topic?: string): void {
  const targets = topic?.trim()
    ? [projectionStoreKey(sessionId, topic)]
    : [...states.keys()].filter((key) => key === sessionId || key.startsWith(`${sessionId}#`));
  let changed = false;
  for (const key of targets) {
    const state = states.get(key);
    if (!state) continue;
    resetCanonical(state);
    state.hydrating = false;
    state.hydrationWatermark = null;
    state.bufferedLive = [];
    touch(state);
    changed = true;
  }
  if (changed) notify();
}

export function clearAllProjections(): void {
  states.clear();
  __resetProjectionCacheForTesting();
  notify();
}

export function projectionStoreKey(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
}

export function __resetProjectionForTests(): void {
  states.clear();
  listeners.clear();
  admittedEnvelopeListeners.clear();
  rehydrateListeners.clear();
  // Runtime owns a process-lifetime recovery hook. Keep that hook installed
  // across state resets so tests exercising reconnect/gap recovery still use
  // the same production wiring.
  __resetProjectionCacheForTesting();
}

if (typeof window !== "undefined") {
  window.addEventListener("crew:token_cleared", clearAllProjections);
}
