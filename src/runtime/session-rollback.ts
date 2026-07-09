/**
 * Session rewind (web parity for the TUI rollback flow; server
 * `session/rollback`, octos #1516/#1517).
 *
 * The RPC is conversation-only and server-authoritative: it drops the
 * last N USER turns (persisted marker + in-memory trim) and returns the
 * trimmed thread projected in the `session/hydrate` shape. Applying it
 * client-side CANNOT go through `setHydrateSnapshot` alone — the hydrate
 * dedup/seed pass only ever ADDS or coalesces rows, it never removes the
 * rolled-back turns from an already-populated ThreadStore. So the applier
 * clears the session scope first, then seeds from the trimmed snapshot
 * (the same `seedFromHydrateMessages` path a reload-mid-stream uses).
 */

import * as ThreadStore from "@/store/thread-store";
import { setHydrateSnapshot } from "@/store/thread-store";
import { getActiveBridge } from "./ui-protocol-runtime";

export type RollbackOutcome =
  | { ok: true; droppedTurns: number }
  | { ok: false; reason: "no_bridge" | "turn_in_progress" | "rpc_failed" };

/** True when the RPC error is the server's while-a-turn-is-live guard
 *  (`invalid_params` with `data.kind === "turn_in_progress"`). The
 *  bridge surfaces RPC errors as `Error` instances whose message embeds
 *  the server text, so match on the stable kind marker. */
function isTurnInProgress(err: unknown): boolean {
  const text =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return text.includes("turn_in_progress") || text.includes("turn is in progress");
}

/**
 * Roll the session back by `numTurns` user turns and rebuild the local
 * thread state from the server's trimmed projection.
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
  let result;
  try {
    result = await bridge.rollbackSession(numTurns);
  } catch (err) {
    return {
      ok: false,
      reason: isTurnInProgress(err) ? "turn_in_progress" : "rpc_failed",
    };
  }
  // Server state is already trimmed — rebuild the local store to match.
  // Clear FIRST: the hydrate seed pass only adds rows; without the clear
  // the rolled-back bubbles would survive locally until a full reload.
  ThreadStore.clearSession(sessionId, topic);
  setHydrateSnapshot(sessionId, topic, {
    messages: result.thread.messages ?? [],
    replayed_envelopes: result.thread.replayed_envelopes,
    replayed_tool_envelopes: result.thread.replayed_tool_envelopes,
  });
  return { ok: true, droppedTurns: result.dropped_turns };
}
