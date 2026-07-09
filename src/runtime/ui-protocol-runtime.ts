/**
 * UI Protocol v1 runtime — owns the active bridge instance keyed by session.
 *
 * The mount effect in `runtime-provider.tsx` calls `startBridgeForSession`
 * when the v1 flag is on; the send path looks up the active bridge via
 * `getActiveBridge`. Only one bridge is active at a time (current session)
 * because a session change tears down the previous bridge before starting
 * the next one. Concurrent sessions are out of scope for C-2.
 */

import {
  createUiProtocolBridge,
  type UiProtocolBridge,
} from "./ui-protocol-bridge";
import type { ConnectionState } from "./ui-protocol-types";
import { attachRouter, type RouterAttachment } from "./ui-protocol-event-router";
import * as AutonomyStore from "@/store/autonomy-store";
import {
  setHydrateSnapshot,
  suppressPendingDeltasForReplay,
} from "@/store/thread-store";
import {
  asStoredEffort,
  markThinkingSeeded,
  setThinkingEffort,
} from "@/store/thinking-store";

interface ActiveBridge {
  sessionId: string;
  topic?: string;
  bridge: UiProtocolBridge;
  attachment: RouterAttachment;
  /** Live connection state, kept in sync via `onConnectionStateChange`.
   *  `getActiveBridge` only returns this entry when it has reached
   *  `"connected"`, so callers (the v1 send path) fall back to legacy
   *  REST/SSE while the WS handshake is still in flight or stalled. */
  connectionState: ConnectionState;
  /** Cleanup fn for the connection-state subscriber. Detached on stop. */
  unsubscribeState: () => void;
  /** Cleanup fn for the reopen subscriber (reload-bug fix). Detached on
   *  stop. The reopen subscriber re-fires `session/hydrate` so missed
   *  envelopes (e.g. a `TurnSpawnComplete` emitted while the WS was
   *  dropped) get replayed via `replayed_envelopes`. */
  unsubscribeReopened: () => void;
  /** Cleanup fn for the session-opened subscriber (thinking-effort
   *  seeding). Detached on stop. */
  unsubscribeSessionOpened: () => void;
}

let active: ActiveBridge | null = null;

/**
 * Monotonic generation counter. Each `startBridgeForSession` /
 * `stopActiveBridge` call increments it; in-flight `start()` resolutions
 * compare their captured generation against the live one before publishing
 * themselves as `active`. A stale start (a newer call ran while we were
 * awaiting the WebSocket handshake) is responsible for stopping its own
 * bridge and discarding the result. Codex review must-fix #4: avoids the
 * pre-fix race where rapid session switches could leak bridges or — worse —
 * have an older `start()` resolution overwrite a newer bridge in `active`.
 */
let generation = 0;

function sameScope(a: ActiveBridge, sessionId: string, topic?: string): boolean {
  const t = topic?.trim() || undefined;
  const at = a.topic?.trim() || undefined;
  return a.sessionId === sessionId && at === t;
}

/**
 * Start a v1 bridge for the given session. If a bridge is already running
 * for the same scope, returns the existing one (idempotent across StrictMode
 * remounts). When called for a different scope, the previous bridge is
 * stopped first.
 *
 * Race-safe: each call captures the current `generation` before awaiting
 * `bridge.start()`. If a newer call (or `stopActiveBridge`) bumped the
 * generation while we were awaiting, this start is stale — we stop the
 * orphaned bridge and ALWAYS THROW, even when a newer same-scope active
 * exists. The throw signals the caller "you did NOT publish this active";
 * callers depending on the published-by-me invariant (e.g. the provider's
 * scope-aware cleanup) can branch on it. Callers wanting "give me the
 * active bridge for this scope, regardless of who published" should use
 * `getActiveBridge(sessionId, topic)` instead.
 */
export async function startBridgeForSession(
  sessionId: string,
  topic?: string,
): Promise<UiProtocolBridge> {
  // Issue #109.4: a same-scope bridge that has hit a terminal state
  // (`closed`/`error`) is dead — returning it makes a "Retry" button a
  // no-op because the consumer keeps holding the corpse. Stop the dead
  // bridge first so the code below creates a fresh one.
  if (
    active &&
    sameScope(active, sessionId, topic) &&
    (active.connectionState === "closed" || active.connectionState === "error")
  ) {
    await stopActiveBridge();
  }
  if (active && sameScope(active, sessionId, topic)) {
    return active.bridge;
  }
  if (active) {
    await stopActiveBridge();
  }
  const myGeneration = ++generation;
  const bridge = createUiProtocolBridge();
  try {
    // Codex BLOCK E: pass `topic` so the bridge can drop cross-topic
    // envelopes client-side. The server-side replay/live scoping by
    // topic is a separate PR; this is best-effort defense in the
    // meantime.
    await bridge.start({ sessionId, topic });
  } catch (err) {
    if (myGeneration === generation) {
      // No newer start raced us; surface the failure.
      throw err;
    }
    // Newer start raced us. Throw rather than masquerade as the publisher.
    throw new Error(
      "ui-protocol-runtime: bridge start superseded during handshake error",
    );
  }
  if (myGeneration !== generation) {
    // A newer `startBridgeForSession` or `stopActiveBridge` ran while
    // we were awaiting the handshake. This bridge is now orphaned —
    // stop it and ALWAYS THROW so the caller does not assume ownership
    // of whatever the live `active` slot holds (it belongs to a newer
    // start, not us).
    try {
      await bridge.stop();
    } catch {
      // best-effort
    }
    throw new Error(
      "ui-protocol-runtime: bridge start superseded by a newer session",
    );
  }
  const attachment = attachRouter(bridge, { sessionId, topic });
  // Track live connection state so `getActiveBridge` can refuse to
  // hand out a bridge that has not yet negotiated `session/open`.
  // Without this, a WS endpoint that is blocked / DNS-fails / hangs in
  // `connecting` would still publish here and the v1 send queue would
  // park every text turn forever instead of falling back to legacy
  // REST/SSE. (codex review M10.5 round 2 P2.)
  let connectionState: ConnectionState = "connecting";
  const unsubscribeState = bridge.onConnectionStateChange((s) => {
    if (active?.bridge === bridge) {
      active.connectionState = s;
    } else {
      connectionState = s;
    }
    // Wake any consumer that gated on `getAnyConnectedBridge()` returning
    // non-null: the auxiliary REST→WS wrappers (`listSessions`,
    // `system/status.get`, `content/list`) check that before falling back
    // to legacy REST. Without this event, the first `refreshSessions()`
    // call on `/chat` mount races the bridge transition to "connected"
    // — when it loses, it falls through to `/api/sessions` (a route
    // retired in M12 Phase D-5 → 404) and the sidebar stays empty until
    // the 15 s polling interval fires. SessionProvider listens for
    // `crew:bridge_connected` and re-runs `refreshSessions()` so the
    // sidebar paints as soon as the bridge handshake completes.
    if (s === "connected" && typeof window !== "undefined") {
      try {
        window.dispatchEvent(new CustomEvent("crew:bridge_connected"));
      } catch {
        // best-effort
      }
    }
  });
  // Reload-bug fix (Yue 2026-05-15): subscribe to the bridge's `onReopened`
  // hook BEFORE the initial hydrate kicks off, so a reconnect that races
  // the initial hydrate still gets handled. The bridge guarantees this
  // event only fires on a SUBSEQUENT successful `session/open` (i.e. after
  // a reconnect) — never on the initial open — so we do not double-hydrate
  // when the bridge first goes live. See `ui-protocol-bridge.ts` →
  // `onWsOpen` for the gating logic (the `isReopen` snapshot of
  // `hasEverOpened`).
  //
  // Defensive: test mocks of `UiProtocolBridge` may pre-date `onReopened`;
  // skip subscription rather than crash so existing tests keep working.
  let unsubscribeReopened: () => void = () => {};
  if (typeof bridge.onReopened === "function") {
    unsubscribeReopened = bridge.onReopened(() => {
      // Only the runtime entry that this start created can speak for the
      // session — a newer `startBridgeForSession` would have torn this
      // bridge down before publishing its own. Use the same generation
      // guard the initial hydrate uses.
      if (myGeneration !== generation) return;
      // #245 P2: the bridge now sends an `after` cursor on reopen, so the
      // server replays the gap as live frames — including `message/delta`,
      // which has no client-side identity. Freeze each in-flight bubble's
      // delta stream FIRST (replayed deltas would double it; clearing would
      // truncate it) — the turn's durable frames deliver canonical text and
      // lift the freeze. Runs for ALL reopens (topic-scoped bridges
      // included), unlike the topic-gated hydrate below.
      suppressPendingDeltasForReplay(sessionId, topic);
      runHydrateFor(sessionId, topic, bridge, myGeneration);
      runAutonomySnapshotFor(sessionId, topic, bridge, myGeneration);
    });
  }
  // Thinking-effort parity: seed the per-session selector from the
  // server-persisted value carried on every `session/open` ack, so a
  // reload/reconnect restores the user's `/thinking`-equivalent choice.
  // ROOT scope only (codex #261 P1): the bridge's `session/open` sends
  // the bare session id, so `opened.reasoning_effort` describes the
  // ROOT bucket — applying it to a topic key would restore the wrong
  // value and let the topic's next turn overwrite the root's choice.
  // Topic scopes are marked seeded-without-value instead (no restore is
  // possible over the current wire; selector still works live).
  // Same defensive-typeof guard as `onReopened` for pre-dating mocks —
  // those are marked seeded too so sends never wait on a seed that
  // cannot arrive.
  let unsubscribeSessionOpened: () => void = () => {};
  const scopeHasTopic = Boolean(topic && topic.trim() !== "");
  if (!scopeHasTopic && typeof bridge.onSessionOpened === "function") {
    unsubscribeSessionOpened = bridge.onSessionOpened((opened) => {
      if (myGeneration !== generation) return;
      setThinkingEffort(
        sessionId,
        asStoredEffort(opened.reasoning_effort),
        topic,
      );
    });
  } else {
    markThinkingSeeded(sessionId, topic);
  }

  active = {
    sessionId,
    topic,
    bridge,
    attachment,
    connectionState,
    unsubscribeState,
    unsubscribeReopened,
    unsubscribeSessionOpened,
  };

  // M10 Phase 6.2 (Bug C): immediately fire `session/hydrate` to fetch
  // the negotiated `replayed_envelopes` + per-row `(message_id,
  // source)`. Cache the result in ThreadStore so any concurrent or
  // subsequent REST `replayHistory` (chat-thread.tsx fires retries at
  // 2s/5s/12s) can dedup the legacy `Background`-source rows the live
  // wire suppresses for negotiated clients. Best-effort: a failure
  // here just falls back to the pre-Bug-C N+1 render.
  //
  // Topic scoping: the WS bridge starts with the bare `sessionId` (no
  // topic), so `session/hydrate` returns data for the ROOT
  // `SessionKey` (which encodes a `#topic` suffix when topics are
  // active server-side). Until the bridge can negotiate topic with
  // the server, restrict the dedup to the no-topic case — the soak
  // suite + Bug C reproducer all run in this scope, and topic-scoped
  // chat (slides/sites) keeps the legacy REST-only render with the
  // pre-fix N+1 limitation. This avoids cross-topic envelope leakage
  // (codex round-2 P2).
  runHydrateFor(sessionId, topic, bridge, myGeneration);
  runAutonomySnapshotFor(sessionId, topic, bridge, myGeneration);

  return bridge;
}

/**
 * Run a `session/hydrate(["messages"])` RPC and push the result into
 * ThreadStore. Used by both the initial bridge start and the post-
 * reconnect reopen path.
 *
 * The reload-bug fix (Yue 2026-05-15) added the reopen call site: the
 * server's `session/open` without an `after` cursor is "live only, no
 * replay" (`ui_protocol_ledger.rs:1199`). Without this RPC, any
 * envelopes the server emitted between disconnect and reconnect (e.g.
 * a `TurnSpawnComplete` for a long-running `spawn_only`) would be
 * silently dropped. Re-hydrating on reopen rolls the ledger forward.
 *
 * Dedup is the caller's responsibility but already covered: ThreadStore's
 * `applyHydrateDedup` (via `setHydrateSnapshot`) coalesces duplicate
 * `(message_id, source)` rows from `replayed_envelopes`, so it is safe
 * to call this multiple times on the same bridge.
 *
 * Generation-guarded: skips if a newer `startBridgeForSession` /
 * `stopActiveBridge` has bumped the global counter, mirroring the
 * race-safety the initial hydrate uses.
 */
function runHydrateFor(
  sessionId: string,
  topic: string | undefined,
  bridge: UiProtocolBridge,
  capturedGeneration: number,
): void {
  if (topic && topic.trim() !== "") return;
  void (async () => {
    if (capturedGeneration !== generation) return;
    // Defensive: test mocks of `UiProtocolBridge` may pre-date this
    // method. Production builds always have it.
    if (typeof bridge.hydrateSession !== "function") return;
    const hydrate = await bridge.hydrateSession(["messages"]);
    if (capturedGeneration !== generation) return;
    if (!hydrate) return;
    setHydrateSnapshot(sessionId, topic, {
      messages: hydrate.messages,
      replayed_envelopes: hydrate.replayed_envelopes,
      replayed_tool_envelopes: hydrate.replayed_tool_envelopes,
    });
  })();
}

/** M15 autonomy chip: snapshot this scope's loops + goal after a
 *  successful (re)open. Live `loop/*` / `session/goal/*` notifications
 *  keep it fresh afterwards; this seeds the store for state created
 *  before the page loaded (the invisible-runaway-loop gap). Best-effort:
 *  an older server rejects the RPCs (feature not negotiated /
 *  method_not_supported) and the chip simply stays hidden. Unlike the
 *  hydrate above this ALSO runs for topic scopes — loops are keyed by
 *  the scoped SessionKey. */
function runAutonomySnapshotFor(
  sessionId: string,
  topic: string | undefined,
  bridge: UiProtocolBridge,
  capturedGeneration: number,
): void {
  void (async () => {
    if (capturedGeneration !== generation) return;
    if (
      typeof bridge.listLoops !== "function" ||
      typeof bridge.getGoal !== "function"
    ) {
      return;
    }
    const [loops, goal] = await Promise.all([
      bridge.listLoops().catch(() => null),
      bridge.getGoal().catch(() => null),
    ]);
    if (capturedGeneration !== generation) return;
    if (loops !== null) {
      AutonomyStore.replaceLoops(sessionId, loops, topic);
    }
    AutonomyStore.setGoal(sessionId, goal, topic);
  })();
}

/**
 * Returns the currently-active bridge if it matches the requested scope.
 *
 * The legacy `connectionState === "closed" | "error"` fail-closed gate
 * was removed (M10.5 Wave A round-3): the SSE fallback that used to
 * pick up turns when the WS bridge was dead is itself buggy for text
 * (Yue 2026-05-07 — SSE is the path M10 was supposed to retire). With
 * the gate dropped, sends always flow through the bridge's own send
 * queue, which:
 *   - parks the turn while `connecting` / `reconnecting` (handshake
 *     latency window),
 *   - errors loudly when the bridge has truly given up so the SPA
 *     surfaces a real "connection lost" state instead of silently
 *     re-routing through SSE and corrupting the thread.
 *
 * Mismatched scopes still return null so callers don't dispatch into
 * the wrong session's transport. Topic-scoped sessions (sites/slides)
 * and media uploads (`kind: image|audio`) reach this with their own
 * scope; the legacy SSE fallback for those consumers lives at the
 * call site, not here.
 */
export function getActiveBridge(
  sessionId: string,
  topic?: string,
): UiProtocolBridge | null {
  if (!active) return null;
  if (!sameScope(active, sessionId, topic)) return null;
  return active.bridge;
}

/**
 * Return the live bridge regardless of session scope, but only when it
 * has reached `"connected"`.
 *
 * M12 Phase D-2 (octos-web #103): the auxiliary REST-to-WS wrappers in
 * `src/api/sessions.ts` / `src/api/content.ts` are not session-scoped —
 * `session/list`, `system/status.get`, `content/list`, etc. address the
 * whole tenant. They reuse whatever bridge happens to be live (started
 * by an open chat session). When no bridge is connected, the wrappers
 * fall back to the existing REST helpers — exactly the behavior the
 * flag-off path uses. The pre-`connected` gate matches the chat send
 * path's policy: a bridge that has not yet completed `session/open` is
 * not yet usable.
 */
export function getAnyConnectedBridge(): UiProtocolBridge | null {
  if (!active) return null;
  if (active.connectionState !== "connected") return null;
  return active.bridge;
}

/**
 * Force-restart a bridge for the given scope. Unlike
 * `startBridgeForSession` (which returns the existing same-scope
 * bridge regardless of state), this ALWAYS tears down any active
 * bridge for the scope first, then starts a fresh one.
 *
 * Issue #109.4: the "Retry" affordance after a terminal bridge failure
 * needs an explicit restart path — the silent same-scope reuse in
 * `startBridgeForSession` would otherwise hand back the dead bridge.
 */
export async function restartBridgeForSession(
  sessionId: string,
  topic?: string,
): Promise<UiProtocolBridge> {
  if (active && sameScope(active, sessionId, topic)) {
    await stopActiveBridge();
  }
  return startBridgeForSession(sessionId, topic);
}

/** Stop the currently-active bridge and detach the router. Idempotent.
 *  Bumps the generation counter so any in-flight `startBridgeForSession`
 *  awaiting a handshake recognizes itself as superseded and stops its
 *  orphaned bridge instead of publishing it. */
export async function stopActiveBridge(): Promise<void> {
  generation++;
  if (!active) return;
  const handle = active;
  active = null;
  handle.attachment.detach();
  handle.unsubscribeState();
  handle.unsubscribeReopened();
  handle.unsubscribeSessionOpened();
  try {
    await handle.bridge.stop();
  } catch {
    // Stop is best-effort — a closing socket throwing must not poison the
    // teardown of the next session's bridge.
  }
}

/** Stop the active bridge ONLY if its scope matches the requested
 *  (sessionId, topic). Returns true if a stop happened, false otherwise.
 *  Used by `runtime-provider.tsx` to safely tear down a scoped bridge
 *  without accidentally stopping a newer effect's active bridge — the
 *  generation counter already prevents stale starts from publishing,
 *  but the provider's cleanup also needs to avoid stopping a sibling. */
export async function stopActiveBridgeIfScope(
  sessionId: string,
  topic?: string,
): Promise<boolean> {
  if (!active) return false;
  if (!sameScope(active, sessionId, topic)) return false;
  // Match — bump generation so any in-flight start sees itself as stale,
  // then perform the same stop as `stopActiveBridge`.
  generation++;
  const handle = active;
  active = null;
  handle.attachment.detach();
  handle.unsubscribeState();
  handle.unsubscribeReopened();
  handle.unsubscribeSessionOpened();
  try {
    await handle.bridge.stop();
  } catch {
    // best-effort
  }
  return true;
}

/** Test-only reset. */
export function __resetUiProtocolRuntimeForTest(): void {
  active = null;
  generation = 0;
}

/** Test-only injection so unit tests can drive a mock bridge into the
 *  runtime registry without spinning up a real WebSocket. Defaults the
 *  connection state to `connected` because all existing test cases
 *  assume the bridge is ready; pass `connectionState` to drive other
 *  states (e.g. `connecting` to exercise the legacy-fallback path). */
export function __setActiveBridgeForTest(
  sessionId: string,
  bridge: UiProtocolBridge,
  topic?: string,
  connectionState: ConnectionState = "connected",
): void {
  active = {
    sessionId,
    topic,
    bridge,
    attachment: { detach: () => {} },
    connectionState,
    unsubscribeState: () => {},
    unsubscribeReopened: () => {},
    unsubscribeSessionOpened: () => {},
  };
  // Injected bridges skip the real `session/open` handshake, so mark the
  // thinking-effort scope seeded — otherwise every test send would stall
  // on `whenThinkingSeeded`'s fail-open timeout.
  markThinkingSeeded(sessionId, topic);
}
