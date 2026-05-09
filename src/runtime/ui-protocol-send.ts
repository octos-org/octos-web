/**
 * UI Protocol v1 send-path entry point for /chat.
 *
 * The user message is mirrored into the thread store and the turn is
 * dispatched through `bridge.sendTurn(...)` over the WS UI Protocol.
 *
 * **Carve-out**: image / voice / requestText still need the legacy SSE
 * `/api/chat` upload because the WS bridge's `TurnStartInput` only
 * accepts `kind: "text"` today. Those sends fall through to
 * `legacySendMessage` so audio + image uploads keep working. Funnelling
 * every send (including the legacy fallback) through `enqueueSendV1`
 * preserves user submission order regardless of transport.
 */

import * as ThreadStore from "@/store/thread-store";
import { displayFilenameFromPath } from "@/lib/utils";
import { sendMessage as legacySendMessage } from "./sse-bridge";
import type { SendOptions } from "./sse-bridge";
import { getActiveBridge } from "./ui-protocol-runtime";
import { request } from "@/api/client";

export type { SendOptions } from "./sse-bridge";

/** Re-validate the stored auth token after a send failure. The api/client
 *  `request()` helper has a built-in 401-interceptor that calls
 *  `clearToken()` + hard-redirects to `/login`, so a successful 401 here
 *  drives the user to re-authenticate instead of leaving them on a /chat
 *  page where the WS will never accept their next send.
 *
 *  Bug we're closing: token expiry mid-session yielded a "WS connection
 *  rejected" close (1008) which surfaces here as a `bridge.sendTurn`
 *  rejection. Pre-fix, the SPA marked the assistant bubble as error and
 *  stopped — the user was stuck on /chat with a dead token, no signal
 *  to re-login. Yue hit this 2026-05-08 testing mini1 (Q1 worked, Q2
 *  vanished into a dead WS).
 *
 *  Probe is best-effort: if /api/auth/me succeeds, the token is still
 *  valid and the WS rejection was for a different reason (server
 *  hiccup, transient race) — we don't want to redirect spuriously.
 *  If /api/auth/me 401s, request()'s interceptor handles cleanup. */
function probeAuthAfterSendFailure(): void {
  void request<unknown>("/api/auth/me").catch(() => {
    // Swallowed — request() already handled redirect via its 401
    // interceptor. Anything we add here would race with that.
  });
}

export function sendMessage(opts: SendOptions): void {
  void enqueueSendV1(opts);
}

function shouldFallbackToLegacy(opts: SendOptions): boolean {
  const hasMedia = opts.media.length > 0;
  const hasRewrite =
    opts.requestText !== undefined && opts.requestText !== opts.text;
  // Topic-scoped surfaces (slides/sites slash-commands) cannot use the WS
  // bridge yet — `session/open` only carries `sessionId` and
  // `TurnStartInput` has no `topic` field, so a bridge.sendTurn would
  // run/persist against the ROOT session while the SPA store/render is
  // scoped to the topic. The legacy `/api/chat` POST sends `topic`
  // explicitly, so keep topic-scoped sends on the legacy transport
  // until the WS protocol carries the topic. (codex review M10.5
  // delete-legacy-render P1.)
  const hasTopic = (opts.historyTopic?.trim().length ?? 0) > 0;
  if (hasMedia || hasRewrite || hasTopic) {
    if (typeof console !== "undefined" && console.info) {
      console.info(
        "ui-protocol-send: v1 path does not yet support media / requestText / topic; falling back to legacy",
        { hasMedia, hasRewrite, hasTopic },
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
    // Token may have been rejected at WS upgrade — probe `/api/auth/me`
    // to surface dead-token cases via api/client's 401 interceptor (which
    // hard-redirects to /login). If the token is still good, this is a
    // no-op and the user can retry.
    probeAuthAfterSendFailure();
  }
}
