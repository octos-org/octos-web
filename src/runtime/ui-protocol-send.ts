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
  // Codex round 4 P2: every v1 send funnels through the per-session
  // queue, including the legacy fallbacks (media/rewrite/no-bridge).
  // Pre-fix, fallback sends bypassed the queue and could overtake an
  // already-queued v1 prompt — the user submits "Q1" (text → queued
  // behind a running turn) then "Q2 with image" (legacy fast-path) and
  // the server sees Q2 first. Funnelling everything through
  // `enqueueSendV1` preserves user submission order regardless of
  // which transport each send eventually picks.
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

// Per-session lock scope. Codex P2: the server's
// `handle_turn_start` "one turn at a time" lock is keyed by `session_id`
// only — `bridge.sendTurn` doesn't carry the SPA-side `historyTopic`,
// so switching topic mid-turn would not relax the server's rejection
// rule. Key the queue on `sessionId` to match the server lock scope
// exactly; otherwise a topic switch lets a fresh prompt through to the
// same-session lock and reproduces the orphan-bubble shape this fix
// targets.
function queueKey(sessionId: string): string {
  return sessionId;
}

async function enqueueSendV1(opts: SendOptions): Promise<void> {
  const key = queueKey(opts.sessionId);
  const prev = turnQueues.get(key) ?? Promise.resolve();

  // Codex round 5 P1: pin the clientMessageId ONCE so the synchronous
  // ThreadStore mirror and the eventual `sendTurn`/lifecycle gate use
  // the same value. Pre-fix, when a caller omitted `clientMessageId`
  // (the chat-thread default), `enqueueSendV1` minted one for the
  // mirror but `sendMessageV1` minted a different one for sendTurn —
  // server events / errors would not attach to the mirrored pending
  // bubble.
  const clientMessageId = opts.clientMessageId ?? crypto.randomUUID();
  const pinnedOpts: SendOptions = { ...opts, clientMessageId };

  // Codex round 4-6 P2: mirror the user message into ThreadStore
  // SYNCHRONOUSLY before the queue gate, so the bubble is visible the
  // instant the user clicks Send — even when a prior turn has not yet
  // emitted `turn/completed`. Pre-fix, `addUserMessage` ran inside
  // `sendMessageV1` AFTER `await prev`, so a queued prompt was
  // invisible until the prior turn drained.
  //
  // This applies to EVERY transport path (v1 text, legacy media,
  // legacy rewrite, no-bridge fallback). The legacy SSE bridge does
  // its own `addUserMessage` mirror later in `legacySendMessage`, but
  // `addUserMessage` is idempotent on an existing `clientMessageId`
  // (`thread-store.ts:addUserMessage` "If a thread already exists with
  // this id, adopt it instead of double-inserting"), so the second
  // call is a no-op. By matching the legacy bridge's mirror semantics
  // (`text` for the bubble even when `requestText` differs) the two
  // paths produce identical store state.
  const localFiles = pinnedOpts.media.map((path) => ({
    filename: displayFilenameFromPath(path),
    path,
    caption: "",
  }));
  ThreadStore.addUserMessage(pinnedOpts.sessionId, {
    text: pinnedOpts.text,
    clientMessageId,
    files: localFiles,
    topic: pinnedOpts.historyTopic,
  });
  pinnedOpts.onSessionActive?.(pinnedOpts.text);

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
    // After the gate clears, decide v1 vs legacy fallback. Re-check
    // bridge availability HERE (rather than at sendMessage entry) so a
    // bridge that was torn down while we were parked correctly falls
    // through to legacy.
    if (shouldFallbackToLegacy(pinnedOpts)) {
      // Codex round 5 P2: tie the queue release to the legacy send's
      // own completion callback. Pre-fix, the queue released
      // immediately after `legacySendMessage` returned (which only
      // schedules the SSE fetch — the actual /api/chat is still in
      // flight). A subsequent v1 `bridge.sendTurn` could then race
      // the legacy turn at the WS one-turn lock. Wrap the caller's
      // `onComplete` so we hold the gate until the legacy stream's
      // `done` (or error) fires.
      const userOnComplete = pinnedOpts.onComplete;
      let released = false;
      legacySendMessage({
        ...pinnedOpts,
        onComplete: () => {
          if (!released) {
            released = true;
            release();
          }
          userOnComplete?.();
        },
      });
      // Defensive timeout: if the legacy bridge never calls
      // `onComplete` (e.g. an unhandled fetch error), match the v1
      // safety net's 15-minute upper bound so the chain still drains.
      const legacySafetyTimer = setTimeout(
        () => {
          if (!released) {
            released = true;
            release();
          }
        },
        15 * 60 * 1000,
      );
      // Don't keep the timer alive past resolution — once the chain
      // advances we don't care about a late onComplete.
      void lifecycleDone.then(() => clearTimeout(legacySafetyTimer));
    } else {
      await sendMessageV1(pinnedOpts, release);
    }
    // Wait for the lifecycle to complete before we let the chain advance.
    // `sendMessageV1` always calls `release()` — on success via the
    // `turn/completed`/`turn/error` listener, on early fallback or RPC
    // failure inline (including the connection-state `closed` listener
    // for codex P2 round 2: bridge teardown cascades release through
    // every parked entry without the 15-min safety wait). So this
    // resolves promptly rather than parking the chain forever.
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
    clientMessageId = crypto.randomUUID(),
    onComplete,
  } = opts;

  // The user message is mirrored into ThreadStore by `enqueueSendV1`
  // BEFORE the queue gate (codex round 4 P2). All sendMessageV1 callers
  // arrive here through `enqueueSendV1` for the v1 path, so the bubble
  // already exists in the thread store. Direct test paths that call
  // `sendMessageV1` without going through the queue must mirror their
  // own user message — but the production export (`sendMessage`) goes
  // through `enqueueSendV1` unconditionally.

  const bridge = getActiveBridge(sessionId, historyTopic);
  if (!bridge) {
    // Bridge was torn down between the queue gate and now. Fall back to
    // legacy. The user bubble is already in the store from
    // `enqueueSendV1`'s synchronous mirror, so the legacy path's own
    // mirror is a no-op (deduped by clientMessageId in ThreadStore).
    legacySendMessage(opts);
    releaseLifecycleGate();
    return;
  }

  // Codex review must-fix #5B: subscribe to the turn lifecycle BEFORE
  // calling `sendTurn`. A fast turn/completed (or turn/error) can fire
  // between the RPC ack and the post-await `finally` block, leaving
  // `sendingRef` (the chat input lock) stuck-true if we install the
  // listener afterwards. The handler also fires `onComplete` on RPC
  // rejection so the input never spins forever on a network failure.
  let completed = false;
  let lifecycleSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  let offState: (() => void) | null = null;
  const fireComplete = () => {
    if (completed) return;
    completed = true;
    if (lifecycleSafetyTimer !== null) {
      clearTimeout(lifecycleSafetyTimer);
      lifecycleSafetyTimer = null;
    }
    if (offState !== null) {
      offState();
      offState = null;
    }
    // Codex round 3 P2: invoke onComplete inside try/finally so a
    // throwing callback cannot wedge the per-session queue. The bridge
    // swallows subscriber exceptions inside its `Subscribers.emit`, so
    // pre-fix a thrown callback unwound past `releaseLifecycleGate`
    // here, the lifecycle promise never resolved, and every subsequent
    // send for the session blocked on the 15-min safety timer.
    try {
      onComplete?.();
    } finally {
      // Bug B: unblock the per-session turn queue so the next
      // `enqueueSendV1` can issue its `bridge.sendTurn`. Calling
      // release multiple times is a no-op.
      releaseLifecycleGate();
    }
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

  // Codex P2 round 2: if the bridge stops (user navigates away from this
  // session/topic, runtime tears down), `bridge.stop()` calls
  // `subTurnLifecycle.clear()` and our `onTurnLifecycle` handler is gone
  // forever — `releaseLifecycleGate` would otherwise wait on the 15-min
  // safety timer. Subscribe to the bridge's connection state and force a
  // release as soon as it transitions to `closed`. Idempotent via the
  // `completed` guard inside `fireComplete`.
  offState = bridge.onConnectionStateChange((s) => {
    if (s === "closed") {
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
    const result = await bridge.sendTurn(clientMessageId, [
      { kind: "text", text },
      // File / voice attachments stay on REST — see fallback above. The
      // bridge schema already accepts a TurnStartInput[] so a future PR
      // can add file references here without changing this call site.
    ]);
    // Codex round 7 P2: if the server's RPC reply is structurally
    // valid but reports `{ accepted: false }`, no `turn/started` will
    // ever fire — the lifecycle gate would otherwise wait the full
    // 15-min safety timer. Mark the bubble errored and release
    // immediately, mirroring the rejected-RPC catch branch below.
    if (!result?.accepted) {
      ThreadStore.finalizeAssistant(clientMessageId, { status: "error" });
      off();
      fireComplete();
    }
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
