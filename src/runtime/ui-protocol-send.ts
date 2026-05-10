/**
 * UI Protocol v1 send-path entry point for /chat.
 *
 * The user message is mirrored into the thread store and the turn is
 * dispatched through `bridge.sendTurn(...)` over the WS UI Protocol.
 *
 * M9-α-5/α-6 (ADR PR #830 / audit issue #845): the legacy SSE bridge
 * (`sse-bridge.ts`) has been deleted along with the server-side SSE
 * chat transport. `/api/ui-protocol/ws` is now the sole chat transport.
 *
 * **Known follow-up**: the WS bridge's `TurnStartInput` only accepts
 * `kind: "text"` today, so media uploads, `/queue` rewrites, and
 * topic-scoped sends are temporarily blocked here — `sendMessage`
 * surfaces an explicit error on the assistant bubble and emits a
 * `console.warn` instead of falling back to a deleted SSE path. The
 * follow-up to extend `TurnStartInput` lives in M9-β.
 */

import * as ThreadStore from "@/store/thread-store";
import { displayFilenameFromPath } from "@/lib/utils";
import { getActiveBridge } from "./ui-protocol-runtime";
import { request } from "@/api/client";

/** Per-turn send options. The legacy SSE bridge previously re-exported
 *  this type; with that file deleted, the canonical home is here. */
export interface SendOptions {
  sessionId: string;
  /** Topic ('/new <slug>' surfaces). Currently unsupported by the WS
   *  bridge — sends with a non-empty topic surface an error. */
  historyTopic?: string;
  text: string;
  /** Optional rewrite (e.g. `/queue` slash-commands). Currently
   *  unsupported by the WS bridge — sends where `requestText !== text`
   *  surface an error. */
  requestText?: string;
  /** Pre-uploaded media paths from `/api/upload`. Currently unsupported
   *  by the WS bridge — sends with non-empty media surface an error. */
  media: string[];
  clientMessageId?: string;
  /** Recording vs upload (audio surface). Unused on the WS path today. */
  audioUploadMode?: "recording" | "upload";
  /** M9-γ-4: Composer renders a `<GhostBubble>` overlay; skip the
   *  optimistic ThreadStore mutation. */
  skipOptimisticUserMessage?: boolean;
  onSessionActive?: (firstMessage: string) => void;
  onComplete?: () => void;
}

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

/** Return a human-readable reason when this send is unsupported by the
 *  WS-only path, else `null`. M9-α-5/α-6 deleted the legacy SSE
 *  fallback — when this returns non-null, the send fails fast with an
 *  errored assistant bubble rather than silently dropping. */
function unsupportedSendReason(opts: SendOptions): string | null {
  if (opts.media.length > 0) {
    return "media uploads are not yet supported on the WS chat transport (follow-up: M9-β extension to `TurnStartInput`)";
  }
  if (opts.requestText !== undefined && opts.requestText !== opts.text) {
    return "`/queue`-style rewrites are not yet supported on the WS chat transport (follow-up: M9-β extension to `TurnStartInput`)";
  }
  if ((opts.historyTopic?.trim().length ?? 0) > 0) {
    return "topic-scoped sends are not yet supported on the WS chat transport (follow-up: M9-β extension to `session/open` / `TurnStartInput`)";
  }
  return null;
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
// Implementation: a per-session promise chain. `enqueueSendV1` pushes the
// next send onto the chain; each send awaits BOTH (a) the prior send's
// completion AND (b) the prior turn's lifecycle event (`turn/completed`
// or `turn/error`) before issuing `bridge.sendTurn`. The chain is keyed
// by `sessionId` to match the server-side lock scope.

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
  // emitted `turn/completed`. The mirror runs once per send; the WS
  // path's own listener never re-mirrors.
  const localFiles = pinnedOpts.media.map((path) => ({
    filename: displayFilenameFromPath(path),
    path,
    caption: "",
  }));
  // M9-γ-4: Composer renders a `<GhostBubble>` overlay under
  // projection_v1; it pre-registers the cmid so the first server-side
  // envelope on this thread carries it (the projection captures it
  // into `UserView.client_message_id` so the ghost can match-and-unmount).
  // Skip the legacy reducer mutation so the ThreadStore stays free of an
  // optimistic row.
  if (!pinnedOpts.skipOptimisticUserMessage) {
    ThreadStore.addUserMessage(pinnedOpts.sessionId, {
      text: pinnedOpts.text,
      clientMessageId,
      files: localFiles,
      topic: pinnedOpts.historyTopic,
    });
  } else {
    ThreadStore.registerPendingClientMessageId(
      pinnedOpts.sessionId,
      clientMessageId,
      pinnedOpts.historyTopic,
    );
  }
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
    // M9-α-5/α-6: legacy SSE fallback removed. If the send is
    // unsupported by the WS path (media, /queue rewrite, topic-scoped),
    // surface an error on the assistant bubble and release the gate
    // immediately so subsequent sends drain.
    const reason = unsupportedSendReason(pinnedOpts);
    if (reason !== null) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn(`ui-protocol-send: ${reason}`);
      }
      ThreadStore.finalizeAssistant(clientMessageId, { status: "error" });
      pinnedOpts.onComplete?.();
      release();
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
  // once on every code path (including the unsupported-send and bridge-
  // unavailable early returns) so the chain never wedges. Defaults to a
  // no-op for backward compatibility / direct test calls.
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
    // Bridge was torn down between the queue gate and now. M9-α-5/α-6
    // removed the legacy SSE fallback — surface an error on the
    // assistant bubble so the user can retry once the bridge mounts.
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        "ui-protocol-send: WS bridge unavailable; cannot send turn",
      );
    }
    ThreadStore.finalizeAssistant(clientMessageId, { status: "error" });
    onComplete?.();
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
