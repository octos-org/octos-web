/**
 * UI Protocol v1 send-path glue for /chat (Phase C-2).
 *
 * Flag-gated wrapper around the legacy SSE-bridge `sendMessage`. When the
 * `chat_app_ui_v1` flag is OFF (the default), this module just delegates
 * to the SSE bridge unchanged so the existing REST+SSE behaviour is bit-
 * for-bit preserved. When ON, the user message is mirrored into the
 * thread store and the turn is dispatched through `bridge.sendTurn(...)`.
 *
 * Image / voice upload stays on REST: the existing `sendMessage` already
 * uploads via `StreamManager.startStream` which posts to `/api/chat`. The
 * v1 path runs in parallel — a follow-up swaps the upload pre-step to a
 * direct REST call once the bridge owns the streaming-turn slice cleanly,
 * but for C-2 we keep the simplest possible split: only the streaming
 * transport changes.
 */

import * as ThreadStore from "@/store/thread-store";
import { isChatAppUiV1Enabled } from "@/lib/feature-flags";
import { displayFilenameFromPath } from "@/lib/utils";
import { sendMessage as legacySendMessage } from "./sse-bridge";
import type { SendOptions } from "./sse-bridge";
import { getActiveBridge } from "./ui-protocol-runtime";

export type { SendOptions } from "./sse-bridge";

export function sendMessage(opts: SendOptions): void {
  if (!isChatAppUiV1Enabled()) {
    legacySendMessage(opts);
    return;
  }
  // Fast-path the legacy fallbacks SYNCHRONOUSLY (no queue) — they don't
  // issue a `bridge.sendTurn`, so they don't compete for the server's
  // "one turn at a time" slot. Pulling them out of the queue path also
  // preserves the original synchronous semantics of `sendMessage(opts);
  // expect(legacySendSpy).toHaveBeenCalledTimes(1)` that the unit tests
  // depend on (no `await` between call and assertion).
  if (shouldFallbackToLegacy(opts)) {
    legacySendMessage(opts);
    return;
  }
  void enqueueSendV1(opts);
}

function shouldFallbackToLegacy(opts: SendOptions): boolean {
  const hasMedia = opts.media.length > 0;
  const hasRewrite =
    opts.requestText !== undefined && opts.requestText !== opts.text;
  if (hasMedia || hasRewrite) {
    if (typeof console !== "undefined" && console.info) {
      console.info(
        "ui-protocol-send: v1 path does not yet support media/requestText; falling back to legacy",
        { hasMedia, hasRewrite },
      );
    }
    return true;
  }
  // No active bridge → legacy fallback (rare race: send before mount).
  if (!getActiveBridge(opts.sessionId, opts.historyTopic)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-session turn-start queue (M10 follow-up Bug B)
// ---------------------------------------------------------------------------
//
// Background: the WS `turn/start` handler enforces "one turn at a time" per
// session — a second `turn/start` arriving while the previous turn's
// foreground phase is still running is rejected with the error
// `"a turn is already running for this session"`
// (see `crates/octos-cli/src/api/ui_protocol.rs::handle_turn_start`).
//
// Pre-fix, `sendMessageV1` called `bridge.sendTurn(...)` immediately. When
// the user (or a soak test) sent a second prompt before the first turn's
// foreground phase finished, the SPA had already added a user bubble via
// `ThreadStore.addUserMessage` but the server then rejected the RPC. The
// bubble stayed on screen with no assistant pair — exactly the `live-
// overflow-stress` failure mode (4 of 5 prompts orphaned at workers=1).
//
// The legacy SSE `/api/chat` path doesn't hit this because the chat backend
// queues concurrent messages server-side (see `stream-manager.ts:191`
// "The backend's queue mode … handles concurrent messages server-side").
// The v1 WS protocol intentionally rejects rather than queues, so the
// queueing has to live on the client.
//
// Implementation: a per-session promise chain. `enqueueSendV1` pushes the
// next send onto the chain; each send awaits BOTH (a) the prior send's
// completion AND (b) the prior turn's lifecycle event (`turn/completed`
// or `turn/error`) before issuing `bridge.sendTurn`. The chain is keyed
// by `(sessionId, historyTopic)` so distinct sessions don't block each
// other.
//
// On falls-through to `legacySendMessage` (no bridge / has media /
// rewrite), we DON'T inject the wait — the legacy path is independent.

const turnQueues = new Map<string, Promise<void>>();

function queueKey(sessionId: string, topic: string | undefined): string {
  const t = topic?.trim();
  return t ? `${sessionId}#${t}` : sessionId;
}

async function enqueueSendV1(opts: SendOptions): Promise<void> {
  const key = queueKey(opts.sessionId, opts.historyTopic);
  const prev = turnQueues.get(key) ?? Promise.resolve();

  // The signal we hand to `sendMessageV1`. The lifecycle handler resolves
  // it on `turn/completed` or `turn/error` (or on early failure inside
  // `sendMessageV1`). The next chained call awaits this signal before
  // issuing its own `bridge.sendTurn`.
  let release!: () => void;
  const lifecycleDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Build the chain entry as a fresh promise we keep a stable reference to,
  // so the cleanup compare-and-delete is correct.
  const chained = prev.then(() => lifecycleDone);
  turnQueues.set(key, chained);

  try {
    await prev;
    await sendMessageV1(opts, release);
    // Wait for the lifecycle to complete before we let the chain advance.
    // `sendMessageV1` always calls `release()` — on success via the
    // `turn/completed`/`turn/error` listener, on early fallback or RPC
    // failure inline — so this resolves promptly rather than parking the
    // chain forever.
    await lifecycleDone;
  } catch {
    // Defensive: if `sendMessageV1` ever rejects without calling release,
    // unblock the chain so a transient failure doesn't wedge subsequent
    // sends.
    release();
  } finally {
    if (turnQueues.get(key) === chained) {
      turnQueues.delete(key);
    }
  }
}

/** Test-only reset for the per-session queue map. */
export function __resetSendQueueForTest(): void {
  turnQueues.clear();
}

async function sendMessageV1(
  opts: SendOptions,
  // Bug B (M10 follow-up): per-session FIFO queue gate. Resolves on the
  // server's `turn/completed`/`turn/error` for THIS turn so the next
  // `enqueueSendV1` call can issue its own `bridge.sendTurn` without
  // racing the server's "one turn at a time" rule. Always called exactly
  // once on every code path (including the legacy fallbacks) so the chain
  // never wedges. Defaults to a no-op for backward compatibility / direct
  // test calls.
  releaseLifecycleGate: () => void = () => {},
): Promise<void> {
  const {
    sessionId,
    historyTopic,
    text,
    requestText,
    media,
    clientMessageId = crypto.randomUUID(),
    onSessionActive,
    onComplete,
  } = opts;

  // Codex review must-fix #5A: TurnStartInput v1 only carries text. Media
  // (image / voice) and `requestText !== text` (e.g. /commands rewrite)
  // need the legacy /api/chat upload pre-step that the SSE bridge owns.
  // Falling back keeps the user's input intact; the next turn picks the
  // v1 transport back up. A `console.info` makes the path switch
  // observable in DevTools without surfacing as a warning.
  const hasMedia = media.length > 0;
  const hasRewrite = requestText !== undefined && requestText !== text;
  if (hasMedia || hasRewrite) {
    if (typeof console !== "undefined" && console.info) {
      console.info(
        "ui-protocol-send: v1 path does not yet support media/requestText; falling back to legacy",
        { hasMedia, hasRewrite },
      );
    }
    legacySendMessage(opts);
    // Legacy SSE path runs independently of the v1 turn-queue. Releasing
    // immediately means the next v1 send won't be blocked behind a
    // legacy-only turn — but that's the right semantic, because the
    // legacy `/api/chat` route is the path that already queues
    // server-side, so the WS turn-collision doesn't apply.
    releaseLifecycleGate();
    return;
  }

  const bridge = getActiveBridge(sessionId, historyTopic);
  if (!bridge) {
    // Bridge has not started yet (rare race: send before mount effect ran).
    // Fall back to the SSE path so the user message is never lost — the
    // session is still functional, just not on the v1 transport for this
    // turn. The next turn will pick up the bridge.
    legacySendMessage(opts);
    // Same reasoning as the media/rewrite fallback above — release so
    // the v1 chain doesn't stall behind a non-v1 turn.
    releaseLifecycleGate();
    return;
  }

  const localFiles = media.map((path) => ({
    filename: displayFilenameFromPath(path),
    path,
    caption: "",
  }));

  // Mirror the legacy bridge's user-message write so the thread store has
  // a thread anchored on this clientMessageId before any server event
  // arrives. The pendingAssistant slot is opened so streaming tokens land
  // in the right slot from the very first delta.
  ThreadStore.addUserMessage(sessionId, {
    text,
    clientMessageId,
    files: localFiles,
    topic: historyTopic,
  });

  onSessionActive?.(text);

  // Codex review must-fix #5B: subscribe to the turn lifecycle BEFORE
  // calling `sendTurn`. A fast turn/completed (or turn/error) can fire
  // between the RPC ack and the post-await `finally` block, leaving
  // `sendingRef` (the chat input lock) stuck-true if we install the
  // listener afterwards. The handler also fires `onComplete` on RPC
  // rejection so the input never spins forever on a network failure.
  let completed = false;
  let lifecycleSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  const fireComplete = () => {
    if (completed) return;
    completed = true;
    if (lifecycleSafetyTimer !== null) {
      clearTimeout(lifecycleSafetyTimer);
      lifecycleSafetyTimer = null;
    }
    onComplete?.();
    // Bug B: also unblock the per-session turn queue so the next
    // `enqueueSendV1` can issue its `bridge.sendTurn`. Calling release
    // multiple times is a no-op.
    releaseLifecycleGate();
  };
  const off = bridge.onTurnLifecycle((e) => {
    if (e.turn_id !== clientMessageId) return;
    // The bridge emits all three lifecycle variants through one channel.
    // We fire on `completed` and `error`; `started` is a no-op here.
    if ("error" in e) {
      off();
      fireComplete();
      return;
    }
    if ("reason" in e) {
      off();
      fireComplete();
    }
  });

  // Bug B safety net: if the server never emits `turn/completed` /
  // `turn/error` for this turn (server crash mid-turn, WS reconnect race
  // that drops the lifecycle frame past the ledger replay window), the
  // per-session queue would otherwise wedge — every subsequent
  // `sendMessage` call sits forever waiting for `lifecycleDone`. Force a
  // release after a generously long upper bound (15 min); long enough
  // that legitimate slow turns (deep_research foreground, mofa-podcast
  // generation) finish well within it, short enough that a wedged
  // session recovers without a page reload. `fireComplete` is
  // idempotent, so a late lifecycle frame after the timeout is a no-op.
  lifecycleSafetyTimer = setTimeout(
    () => {
      if (!completed) {
        off();
        fireComplete();
      }
    },
    15 * 60 * 1000,
  );

  try {
    await bridge.sendTurn(clientMessageId, [
      { kind: "text", text },
      // File / voice attachments stay on REST — see fallback above. The
      // bridge schema already accepts a TurnStartInput[] so a future PR
      // can add file references here without changing this call site.
    ]);
  } catch {
    // Surface as an error message in the thread so the user isn't left
    // with a silent dead pending bubble. The bridge already emits a
    // `warning` for transport-level failures; this just guarantees the
    // thread terminates rather than spinning forever.
    ThreadStore.finalizeAssistant(clientMessageId, { status: "error" });
    off();
    fireComplete();
  }
}
