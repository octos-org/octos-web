/**
 * Session rewind (web parity for the TUI rollback flow; server
 * `session/rollback`, octos #1516/#1517).
 *
 * The RPC is conversation-only and server-authoritative: it drops the
 * last N USER turns (persisted marker + in-memory trim) and returns the
 * trimmed thread projected in the `session/hydrate` shape.
 *
 * Local application replaces the affected canonical projection scope from a
 * fresh server snapshot. The dashboard never reconstructs rendered history
 * from legacy persisted-message rows.
 *
 * Concurrency: rollbacks are RELATIVE ("last N"), so two in-flight
 * rollbacks — or a send racing the trim — can delete unintended turns.
 * A per-scope lock serializes them: `rollbackSessionTurns` refuses to
 * start while one is running (`busy`), every Rewind button disables via
 * `useRollbackBusy`, and the send path parks new turns behind
 * `whenRollbackIdle` until the snapshot is applied.
 */

import { useSyncExternalStore } from "react";
import * as ProjectionStore from "@/store/projection-store";
import {
  parseProjectionEnvelopeV2,
  type ProjectionEnvelopeV2,
} from "./projection-envelope-v2";
import { getActiveBridge } from "./ui-protocol-runtime";

export type RollbackOutcome =
  | { ok: true; droppedTurns: number }
  | {
      ok: false;
      reason: "no_bridge" | "turn_in_progress" | "rpc_failed" | "busy";
    };

// ── per-scope mutation lock ────────────────────────────────────────────────

const busyKeys = new Set<string>();
const busyListeners = new Set<() => void>();
const idleWaiters = new Map<string, Array<() => void>>();

function scopeKey(sessionId: string, topic?: string): string {
  const trimmedTopic = topic?.trim();
  return trimmedTopic ? `${sessionId}#${trimmedTopic}` : sessionId;
}

function setBusy(key: string, value: boolean): void {
  if (value) {
    busyKeys.add(key);
  } else {
    busyKeys.delete(key);
    const waiters = idleWaiters.get(key);
    if (waiters) {
      idleWaiters.delete(key);
      for (const resolve of waiters) resolve();
    }
  }
  for (const listener of busyListeners) listener();
}

export function isRollbackBusy(sessionId: string, topic?: string): boolean {
  return busyKeys.has(scopeKey(sessionId, topic));
}

/** React hook: true while a rollback is applying for the scope. Every
 *  Rewind affordance disables on it so a second RELATIVE rollback
 *  cannot be confirmed against pre-trim indices. */
export function useRollbackBusy(sessionId: string, topic?: string): boolean {
  const subscribe = (listener: () => void) => {
    busyListeners.add(listener);
    return () => {
      busyListeners.delete(listener);
    };
  };
  return useSyncExternalStore(
    subscribe,
    () => isRollbackBusy(sessionId, topic),
    () => isRollbackBusy(sessionId, topic),
  );
}

/** Resolves when no rollback is applying for the scope (immediately if
 *  idle). The send path parks new turns on this so a just-sent bubble
 *  cannot be wiped by the trim that lands moments later. Bounded
 *  fail-open so a stuck lock can never wedge sends. */
export function whenRollbackIdle(
  sessionId: string,
  topic: string | undefined,
  timeoutMs = 5000,
): Promise<void> {
  const key = scopeKey(sessionId, topic);
  if (!busyKeys.has(key)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const waiters = idleWaiters.get(key);
      if (waiters) {
        const next = waiters.filter((w) => w !== wrapped);
        if (next.length === 0) idleWaiters.delete(key);
        else idleWaiters.set(key, next);
      }
      resolve();
    }, timeoutMs);
    const wrapped = () => {
      clearTimeout(timer);
      resolve();
    };
    const waiters = idleWaiters.get(key) ?? [];
    waiters.push(wrapped);
    idleWaiters.set(key, waiters);
  });
}

// ── rollback ───────────────────────────────────────────────────────────────

/** True when the RPC error is the server's while-a-turn-is-live guard
 *  (`invalid_params` with `data.kind === "turn_in_progress"`). The
 *  bridge surfaces RPC errors as `Error` instances whose message embeds
 *  the server text, so match on the stable kind marker. */
function isTurnInProgress(err: unknown): boolean {
  const text =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    text.includes("turn_in_progress") || text.includes("turn is in progress")
  );
}

/** Reconcile a v2 rollback from the server's durable projection snapshot.
 * The legacy rollback payload is deliberately not translated into canonical
 * envelopes: doing so would recreate the retired shadow path. If an older
 * hydrate response has no v2 snapshot carrier, clear the affected canonical
 * scope rather than showing rows the server has just removed. */
async function reconcileProjectionAfterRollback(
  sessionId: string,
  topic: string | undefined,
  bridge: ReturnType<typeof getActiveBridge>,
): Promise<void> {
  if (!bridge) return;
  const projectionKey = ProjectionStore.projectionStoreKey(sessionId, topic);
  const priorWatermark = ProjectionStore.getWatermark(projectionKey);
  ProjectionStore.beginSnapshot(projectionKey, priorWatermark);
  let replaced = false;
  try {
    if (typeof bridge.hydrateSession !== "function") return;
    const hydrate = await bridge.hydrateSession(["messages"]);
    const raw = hydrate?.projection_snapshot?.envelopes ??
      hydrate?.projection_envelopes;
    if (raw === undefined) return;
    const envelopes = raw
      .map((frame) => parseProjectionEnvelopeV2(frame))
      .filter(
        (parsed): parsed is { ok: true; value: ProjectionEnvelopeV2 } =>
          parsed.ok,
      )
      .map((parsed) => parsed.value)
      .filter((envelope) => {
        if (envelope.session_id !== sessionId) return false;
        const snapshotTopic = envelope.topic?.trim() || undefined;
        const requestedTopic = topic?.trim() || undefined;
        return snapshotTopic === undefined || snapshotTopic === requestedTopic;
      });
    const cursor = hydrate?.projection_snapshot?.cursor ?? hydrate?.cursor;
    ProjectionStore.replaceSnapshot(
      projectionKey,
      envelopes,
      cursor?.stream ? cursor : null,
    );
    replaced = true;
  } finally {
    if (!replaced) {
      // No canonical snapshot is available. Replace (rather than merely
      // finish) so rows deleted by the rollback cannot remain rendered.
      ProjectionStore.replaceSnapshot(
        projectionKey,
        [],
        priorWatermark,
      );
    }
  }
}

/**
 * Roll the session back by `numTurns` user turns and replace the local
 * canonical projection with the server's post-rollback snapshot.
 */
export async function rollbackSessionTurns(
  sessionId: string,
  topic: string | undefined,
  numTurns: number,
): Promise<RollbackOutcome> {
  const bridge = getActiveBridge(sessionId, topic);
  if (!bridge || typeof bridge.rollbackSession !== "function") {
    return { ok: false, reason: "no_bridge" };
  }
  const key = scopeKey(sessionId, topic);
  if (busyKeys.has(key)) {
    // A rollback is already applying; a second RELATIVE count computed
    // against pre-trim indices would delete unintended turns.
    return { ok: false, reason: "busy" };
  }
  setBusy(key, true);
  try {
    let result;
    try {
      result = await bridge.rollbackSession(numTurns);
    } catch (err) {
      return {
        ok: false,
        reason: isTurnInProgress(err) ? "turn_in_progress" : "rpc_failed",
      };
    }
    await reconcileProjectionAfterRollback(sessionId, topic, bridge);
    return { ok: true, droppedTurns: result.dropped_turns };
  } finally {
    setBusy(key, false);
  }
}
