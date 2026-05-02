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
import { attachRouter, type RouterAttachment } from "./ui-protocol-event-router";

interface ActiveBridge {
  sessionId: string;
  topic?: string;
  bridge: UiProtocolBridge;
  attachment: RouterAttachment;
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
  active = { sessionId, topic, bridge, attachment };
  return bridge;
}

/**
 * Returns the currently-active bridge if it matches the requested scope.
 * Mismatched scopes return null so callers fall back to the legacy path
 * rather than dispatching a turn into the wrong session's transport.
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
 *  runtime registry without spinning up a real WebSocket. */
export function __setActiveBridgeForTest(
  sessionId: string,
  bridge: UiProtocolBridge,
  topic?: string,
): void {
  active = {
    sessionId,
    topic,
    bridge,
    attachment: { detach: () => {} },
  };
}
