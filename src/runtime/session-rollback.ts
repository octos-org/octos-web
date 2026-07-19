/**
 * Session rewind (web parity for the TUI rollback flow; server
 * `session/rollback`, octos #1516/#1517).
 *
 * The RPC is conversation-only and server-authoritative: it drops the
 * last N USER turns (persisted marker + in-memory trim) and returns the
 * trimmed thread projected in the `session/hydrate` shape.
 *
 * Local application is a SURGICAL SUFFIX TRIM, not a clear+reseed
 * (codex #262 round 1): `dropLastUserTurnThreads` removes the dropped
 * user-turn threads (placeholder orphans excluded from the count) and
 * everything after the cut, keeping surviving thread objects — and
 * with them their tool cards, progress timelines, and message meta,
 * which the hydrate rows cannot rebuild. Only when the local view
 * disagrees with the server's `dropped_turns` (local rows were already
 * inconsistent) — or the server CLAMPED the requested count — does it
 * fall back to an exact-key clear + reseed from the returned
 * projection; `clearSessionScope` never touches sibling topic caches
 * the RPC did not mutate. Either way the scope's hydrate-snapshot
 * cache is replaced with the trimmed projection and the seq-dedup
 * ledger is rebuilt from surviving rows (the server renumbers
 * persisted seqs from the trimmed length).
 *
 * Concurrency: rollbacks are RELATIVE ("last N"), so two in-flight
 * rollbacks — or a send racing the trim — can delete unintended turns.
 * A per-scope lock serializes them: `rollbackSessionTurns` refuses to
 * start while one is running (`busy`), every Rewind button disables via
 * `useRollbackBusy`, and the send path parks new turns behind
 * `whenRollbackIdle` until the snapshot is applied.
 */

import { useSyncExternalStore } from "react";
import * as ThreadStore from "@/store/thread-store";
import { setHydrateSnapshot } from "@/store/thread-store";
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
 * Roll the session back by `numTurns` user turns and trim the local
 * thread state to match.
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
    if (ProjectionStore.isProjectionV2Enabled(sessionId, topic)) {
      await reconcileProjectionAfterRollback(sessionId, topic, bridge);
      return { ok: true, droppedTurns: result.dropped_turns };
    }
    const droppedLocally = ThreadStore.dropLastUserTurnThreads(
      sessionId,
      topic,
      result.dropped_turns,
    );
    // Reconcile from the authoritative projection when EITHER side
    // disagrees (codex #262 round 2):
    //   • server clamped (`dropped_turns !== numTurns`): the request
    //     was computed against local indices the server didn't share,
    //     so the surviving local rows are not trustworthy either;
    //   • local trim count mismatched: local rows were already
    //     inconsistent.
    // Exact-key clear — sibling topic caches were not mutated by the
    // RPC and must survive. This degraded path loses rich per-turn UI
    // state; the surgical trim above is the normal path precisely to
    // avoid that.
    const serverClamped = result.dropped_turns !== numTurns;
    if (serverClamped || droppedLocally !== result.dropped_turns) {
      ThreadStore.clearSessionScope(sessionId, topic);
    } else {
      // Surgical path: the local trim rebuilt the seq ledger from
      // surviving rows' historySeq, which a prior messages_page replay
      // may have stripped (and companion merges collapse). Union the
      // AUTHORITATIVE surviving seqs from the rollback projection so
      // live re-emissions for surviving rows keep deduping
      // (codex #262 round 3).
      ThreadStore.unionSeenSeqs(
        sessionId,
        topic,
        (result.thread.messages ?? [])
          .map((m) => m.seq)
          .filter((n): n is number => typeof n === "number"),
      );
    }
    // ALWAYS replace the hydrate cache with the trimmed projection —
    // surgical path included (codex #262 round 2). The pre-rollback
    // snapshot still contains the dropped turns; a later
    // `replayHistory`/dedup pass reading it would resurrect them. On
    // the surgical path the store keeps its surviving threads and the
    // dedup pass only coalesces; on the reconcile path it reseeds the
    // just-cleared scope.
    setHydrateSnapshot(sessionId, topic, {
      messages: result.thread.messages ?? [],
      replayed_envelopes: result.thread.replayed_envelopes,
      replayed_tool_envelopes: result.thread.replayed_tool_envelopes,
    });
    return { ok: true, droppedTurns: result.dropped_turns };
  } finally {
    setBusy(key, false);
  }
}
