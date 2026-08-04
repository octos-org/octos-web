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
import {
  parseProjectionEnvelopeV2,
  type ProjectionEnvelopeV2,
} from "./projection-envelope-v2";
import type {
  ConnectionState,
  UiGoalRecord,
  UiLoopRecord,
} from "./ui-protocol-types";
import { attachRouter, type RouterAttachment } from "./ui-protocol-event-router";
import * as AutonomyStore from "@/store/autonomy-store";
import * as ProjectionStore from "@/store/projection-store";
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
  /** Live connection state, kept in sync via `onConnectionStateChange` for
   *  lifecycle observers and auxiliary request wrappers. */
  connectionState: ConnectionState;
  /** Cleanup fn for the connection-state subscriber. Detached on stop. */
  unsubscribeState: () => void;
  /** Cleanup fn for the reopen subscriber. Detached on stop. */
  unsubscribeReopened: () => void;
  /** Cleanup fn for the session-opened subscriber (thinking-effort
   *  seeding). Detached on stop. */
  unsubscribeSessionOpened: () => void;
}

let active: ActiveBridge | null = null;

// The canonical store owns gap detection. Keep this bridge-level callback
// narrow: it only hydrates the currently mounted scope and never reaches
// into ThreadStore while v2 is active.
ProjectionStore.onRehydrateRequested((storeKey) => {
  const current = active;
  if (!current) return;
  if (
    ProjectionStore.projectionStoreKey(current.sessionId, current.topic) !==
    storeKey
  ) {
    return;
  }
  runHydrateFor(current.sessionId, current.topic, current.bridge, generation);
}, { persistent: true });

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
  // Track live connection state for lifecycle observers. The bridge's send
  // queue holds turns through the handshake/reconnect window and reports a
  // terminal transport failure when recovery is exhausted.
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

  // Immediately hydrate the canonical v2 snapshot. The bridge keeps live
  // envelopes buffered atomically while this snapshot is installed.
  runHydrateFor(sessionId, topic, bridge, myGeneration);
  runAutonomySnapshotFor(sessionId, topic, bridge, myGeneration);

  return bridge;
}

/**
 * Run a `session/hydrate(["messages"])` RPC and install its canonical v2
 * snapshot. Used by both the initial bridge start and the post-reconnect
 * reopen path.
 *
 * The reload-bug fix (Yue 2026-05-15) added the reopen call site: the
 * server's `session/open` without an `after` cursor is "live only, no
 * replay" (`ui_protocol_ledger.rs:1199`). Without this RPC, any
 * envelopes the server emitted between disconnect and reconnect (e.g.
 * a `TurnSpawnComplete` for a long-running `spawn_only`) would be
 * silently dropped. Re-hydrating on reopen rolls the ledger forward.
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
  const projectionKey = ProjectionStore.projectionStoreKey(sessionId, topic);
  const ownsProjectionSnapshot = ProjectionStore.beginSnapshot(
    projectionKey,
    ProjectionStore.getWatermark(projectionKey),
  );
  // A reconnect hydrate and a gap recovery can race. The first one owns the
  // atomic snapshot transition; its buffered-live replay covers both causes,
  // so a second RPC must not finish or replace the first one's buffer.
  if (!ownsProjectionSnapshot) return;
  void (async () => {
    if (capturedGeneration !== generation) {
      if (ownsProjectionSnapshot) {
        ProjectionStore.finishSnapshotWithoutReplace(projectionKey);
      }
      return;
    }
    // Defensive: test mocks of `UiProtocolBridge` may pre-date this
    // method. Production builds always have it.
    if (typeof bridge.hydrateSession !== "function") {
      if (ownsProjectionSnapshot) {
        ProjectionStore.finishSnapshotWithoutReplace(projectionKey);
      }
      return;
    }
    try {
      const hydrate = await bridge.hydrateSession(["messages"]);
      if (capturedGeneration !== generation) return;
      if (!hydrate) return;
      const rawSnapshot =
        hydrate.projection_snapshot?.envelopes ?? hydrate.projection_envelopes;
      if (rawSnapshot === undefined) return;
      const envelopes = rawSnapshot
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
          // Older servers omit `topic` from a snapshot that was already
          // scoped by the hydrate request. An explicit mismatched topic
          // is never safe to install into this bucket.
          return snapshotTopic === undefined || snapshotTopic === requestedTopic;
        });
      const cursor = hydrate.projection_snapshot?.cursor ?? hydrate.cursor;
      ProjectionStore.replaceSnapshot(
        projectionKey,
        envelopes,
        cursor?.stream ? cursor : null,
      );
    } finally {
      if (ownsProjectionSnapshot) {
        ProjectionStore.finishSnapshotWithoutReplace(projectionKey);
      }
    }
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
    // Distinct FAILURE sentinel (codex #263 round 1 P2): `getGoal()`
    // legitimately resolves `null` for "no goal" and that null is
    // authoritative — but a REJECTED read (timeout, reconnect blip,
    // method_not_supported) must not masquerade as it and wipe a
    // previously loaded or live-updated goal. Same for loops.
    const failed = Symbol("autonomy-read-failed");
    const [loops, goal] = await Promise.all([
      bridge.listLoops().catch(() => failed),
      bridge.getGoal().catch(() => failed),
    ]);
    if (capturedGeneration !== generation) return;
    if (loops !== failed) {
      AutonomyStore.replaceLoops(sessionId, loops as UiLoopRecord[], topic);
    }
    if (goal !== failed) {
      AutonomyStore.setGoal(sessionId, goal as UiGoalRecord | null, topic);
    }
  })();
}

/**
 * Returns the currently-active bridge if it matches the requested scope.
 *
 * Sends always flow through the bridge's own send queue, which:
 *   - parks the turn while `connecting` / `reconnecting` (handshake
 *     latency window),
 *   - errors loudly when the bridge has truly given up so the SPA
 *     surfaces a real "connection lost" state instead of silently
 *     re-routing through SSE and corrupting the thread.
 *
 * Mismatched scopes still return null so callers don't dispatch into
 * the wrong session's transport. Topic-scoped sessions (sites/slides)
 * and media uploads (`kind: image|audio`) reach this with their own
 * scope; callers must never dispatch into a different session or topic.
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

// ---- Sessionless auxiliary bridge (settings surface) ----

/** The settings page mounts OUTSIDE `OctosRuntimeProvider`, so no
 *  session-scoped bridge exists there — and navigating chat → settings
 *  unmounts the provider, which stops the chat bridge (codex web#268 r1
 *  P1). Auxiliary methods (`memory/overview`, `memory/entity`,
 *  `cron/list`, `cron/toggle`) bind to connection identity only, so one
 *  lazy SESSIONLESS bridge (no `session/open`, no event scope) serves
 *  the whole page. Singleton by design: reused across tabs/visits,
 *  replaced when it reaches a terminal state, torn down on
 *  `crew:auth_expired` alongside the token. */
interface AuxBridgeSlot {
  bridge: UiProtocolBridge;
  connectionState: ConnectionState;
  unsubscribeState: () => void;
}

let auxSlot: AuxBridgeSlot | null = null;
let auxStartInFlight: Promise<UiProtocolBridge> | null = null;
/** Monotonic teardown counter (codex web#268 r3 P1): `stopAuxBridge`
 *  bumps it, and an in-flight `ensureAuxBridge` start compares its
 *  captured value before publishing. Without this, a token clear that
 *  lands while `bridge.start({})` is still awaiting finds `auxSlot`
 *  null (nothing to stop) — and the old-token socket would publish
 *  itself AFTER the logout, surviving into the next account's session. */
let auxGeneration = 0;

/**
 * Return a bridge suitable for auxiliary (non-session-scoped) RPCs.
 * Prefers a connected chat-scoped bridge; otherwise starts (or reuses)
 * the sessionless singleton. Concurrent callers share one start.
 * A singleton in a terminal state (`closed`/`error`) is stopped and
 * replaced so a "Reload" after re-login gets a live socket.
 */
export async function ensureAuxBridge(): Promise<UiProtocolBridge> {
  const chat = getAnyConnectedBridge();
  if (chat) return chat;
  if (auxSlot && !auxSlot.bridge.isTerminal()) {
    // Reuse across `connecting`, transient `error`, and `reconnecting`:
    // `callMethod` parks requests on the bridge's send queue and
    // `flushSendQueue` drains it after (re)connect. Replacing on a
    // transient `error` would reject those queued RPCs mid-recovery
    // (codex web#268 r2 P2) — only a TERMINAL bridge (stopped, or
    // reconnect abandoned / auth-latched) is torn down and replaced.
    return auxSlot.bridge;
  }
  if (auxStartInFlight) return auxStartInFlight;
  const myStart = (async () => {
    // Captured BEFORE any await (codex web#268 r4 P1): the internal
    // replacement stop below uses `stopAuxSlotOnly` (no generation
    // bump), so ANY bump observed later is an external teardown —
    // including one that fires while that stop is yielding. The r3
    // version captured after the stop and absorbed such a clear as
    // its baseline, publishing a bridge opened post-logout.
    const myGeneration = auxGeneration;
    if (auxSlot) {
      await stopAuxSlotOnly();
    }
    const bridge = createUiProtocolBridge();
    let connectionState: ConnectionState = "connecting";
    const unsubscribeState = bridge.onConnectionStateChange((s) => {
      if (auxSlot?.bridge === bridge) {
        auxSlot.connectionState = s;
      } else {
        connectionState = s;
      }
    });
    try {
      await bridge.start({});
    } catch (err) {
      unsubscribeState();
      try {
        await bridge.stop();
      } catch {
        // best-effort
      }
      throw err;
    }
    if (myGeneration !== auxGeneration) {
      // A token clear landed while the handshake was in flight: this
      // socket authenticated with the CLEARED token and must not
      // publish. Stop it and reject so the caller retries under the
      // live credentials.
      unsubscribeState();
      try {
        await bridge.stop();
      } catch {
        // best-effort
      }
      throw new Error(
        "ui-protocol-runtime: auxiliary bridge start superseded by token clear",
      );
    }
    auxSlot = { bridge, connectionState, unsubscribeState };
    return bridge;
  })();
  auxStartInFlight = myStart;
  try {
    return await myStart;
  } finally {
    // Only the OWNER clears the shared handle (codex web#268 r4 P2):
    // when a token clear invalidated this start and a newer start B
    // already took the slot, an unconditional clear here would erase
    // B's handle and let a third caller race a bridge C against it.
    if (auxStartInFlight === myStart) {
      auxStartInFlight = null;
    }
  }
}

/** Stop and detach the CURRENT aux slot without touching the teardown
 *  generation or the in-flight handle. Internal replacement path only —
 *  external teardown (logout/auth-expiry) goes through
 *  [`stopAuxBridge`], whose generation bump is exactly what
 *  `ensureAuxBridge` uses to detect it. */
async function stopAuxSlotOnly(): Promise<void> {
  const slot = auxSlot;
  if (!slot) return;
  auxSlot = null;
  slot.unsubscribeState();
  try {
    await slot.bridge.stop();
  } catch {
    // best-effort
  }
}

/** Stop and clear the sessionless auxiliary bridge (auth expiry,
 *  logout, tests). Also invalidates any IN-FLIGHT `ensureAuxBridge`
 *  start (codex web#268 r3 P1) — the pending promise rejects instead
 *  of publishing a socket authenticated with the cleared token — and
 *  drops the shared in-flight handle so the next caller starts fresh. */
export async function stopAuxBridge(): Promise<void> {
  auxGeneration++;
  auxStartInFlight = null;
  await stopAuxSlotOnly();
}

// The aux bridge is identity-bound (authenticated at the WS upgrade),
// so it must not outlive the token that authenticated it:
//  - `crew:auth_expired` — a dead token latches the bridge into a
//    reconnect loop that can never succeed.
//  - `crew:token_cleared` — an ORDINARY logout never fires
//    `auth_expired` (codex web#268 r2 P1); without this, a
//    logout → login as another account would reuse the socket still
//    authenticated as the PREVIOUS user for memory/cron reads and
//    toggles.
// The next `/settings` visit after re-login starts a fresh one.
if (typeof window !== "undefined") {
  window.addEventListener("crew:auth_expired", () => {
    void stopAuxBridge();
  });
  window.addEventListener("crew:token_cleared", () => {
    void stopAuxBridge();
  });
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
  if (auxSlot) {
    auxSlot.unsubscribeState();
    // Best-effort async stop; tests inject mocks whose `stop()` resolves
    // synchronously, and a leaked real socket would be closed by jsdom
    // teardown anyway.
    void auxSlot.bridge.stop().catch(() => {});
  }
  auxSlot = null;
  auxStartInFlight = null;
  auxGeneration = 0;
}

/** Test-only injection so unit tests can drive a mock bridge into the
 *  runtime registry without spinning up a real WebSocket. Defaults the
 *  connection state to `connected` because all existing test cases
 *  assume the bridge is ready; pass `connectionState` to exercise other
 *  lifecycle states such as `connecting`. */
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
