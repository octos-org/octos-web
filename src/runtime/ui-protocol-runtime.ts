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
import { setHydrateSnapshot } from "@/store/thread-store";

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
  if (active && sameScope(active, sessionId, topic)) {
    return active.bridge;
  }
  if (active) {
    await stopActiveBridge();
  }
  const myGeneration = ++generation;
  const bridge = createUiProtocolBridge();
  try {
    await bridge.start({ sessionId });
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
  });
  active = {
    sessionId,
    topic,
    bridge,
    attachment,
    connectionState,
    unsubscribeState,
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
  if (!topic || topic.trim() === "") {
    void (async () => {
      if (myGeneration !== generation) return;
      // Defensive: test mocks of `UiProtocolBridge` may pre-date this
      // method. Production builds always have it.
      if (typeof bridge.hydrateSession !== "function") return;
      const hydrate = await bridge.hydrateSession(["messages"]);
      if (myGeneration !== generation) return;
      if (!hydrate) return;
      setHydrateSnapshot(sessionId, topic, {
        messages: hydrate.messages,
        replayed_envelopes: hydrate.replayed_envelopes,
      });
    })();
  }

  return bridge;
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
  };
}
