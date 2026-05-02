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
  const bridge = createUiProtocolBridge();
  await bridge.start({ sessionId });
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

/** Stop the currently-active bridge and detach the router. Idempotent. */
export async function stopActiveBridge(): Promise<void> {
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

/** Test-only reset. */
export function __resetUiProtocolRuntimeForTest(): void {
  active = null;
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
