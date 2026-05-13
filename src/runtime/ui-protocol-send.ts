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
 * M9-β-1 (UPCR-2026-015 / server PR #860): `TurnStartParams` gained
 * three optional fields — `media: FileRef[]`, `topic: string`,
 * `rewrite_for: client_message_id`. The web client populates them
 * from the existing `SendOptions.media` / `historyTopic` /
 * `requestText` fields; the bridge serialises only the populated
 * extras onto the wire so the on-wire shape stays byte-identical to
 * a pre-β-1 build for text-only sends.
 */

import * as ThreadStore from "@/store/thread-store";
import { displayFilenameFromPath } from "@/lib/utils";
import { getActiveBridge, startBridgeForSession } from "./ui-protocol-runtime";
import { BridgeStoppedError } from "./ui-protocol-bridge";
import type { TurnStartExtras, TurnStartMediaRef } from "./ui-protocol-types";
import { request } from "@/api/client";

/** Per-turn send options. The legacy SSE bridge previously re-exported
 *  this type; with that file deleted, the canonical home is here. */
export interface SendOptions {
  sessionId: string;
  /** Sub-topic suffix (`/new <slug>` surfaces, slides/sites scoping).
   *  M9-β-1 (UPCR-2026-015): forwarded to the server as `topic` on
   *  `turn/start` so history / ledger / `task/list` see the per-topic
   *  bucket. Empty / undefined sends to the default-topic bucket. */
  historyTopic?: string;
  text: string;
  /** Optional rewrite (e.g. `/queue` slash-commands). M9-β-1:
   *  forwarded as `rewrite_for: <client_message_id>` so the server
   *  can replace the queued user message in place rather than
   *  appending. (β-1 server logs the field; durable in-place ledger
   *  replace lands in a follow-up — the wire field is forward-
   *  compatible.) Sends where `requestText === text` (or undefined)
   *  carry no `rewrite_for`. */
  requestText?: string;
  /** Pre-uploaded media paths from `/api/upload`. M9-β-1: forwarded
   *  as `media: FileRef[]` on `turn/start`. The server feeds the
   *  paths to `Agent::process_message`, the same entry the
   *  gateway-mode `ApiChannel` and `octos chat` CLI use. */
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

/** UPCR-2026-015 (M9-β-1): build the `TurnStartParams` extras envelope
 *  from `SendOptions`. Returns `undefined` when no extras are
 *  populated so the bridge omits all three fields and the on-wire
 *  shape stays byte-identical to a pre-β-1 text-only send. */
function buildTurnStartExtras(opts: SendOptions): TurnStartExtras | undefined {
  const extras: TurnStartExtras = {};

  if (opts.media.length > 0) {
    // The `/api/upload` endpoint returns paths only — `mime` and
    // `size_bytes` are not propagated through `SendOptions.media`
    // (the legacy SSE path also had this limitation). Surface what
    // we know and let the server resolve metadata at consume time.
    // The wire-shape requires the fields, so synthesise placeholders
    // (mirroring the legacy SSE behaviour); the server's
    // `process_message` only reads `path`, so the placeholders never
    // leak into render.
    const media: TurnStartMediaRef[] = opts.media.map((path) => ({
      path,
      mime: "application/octet-stream",
      size_bytes: 0,
    }));
    extras.media = media;
  }

  const topic = opts.historyTopic?.trim();
  if (topic && topic.length > 0) {
    extras.topic = topic;
  }

  // `rewrite_for` carries the client_message_id of the original
  // queued send. The Composer's `/queue` slash-command flow stashes
  // the user-edited prompt in `requestText` while `text` keeps the
  // original-with-attached-files form. When the two diverge, treat
  // it as a rewrite and pass the cmid for the original turn.
  if (
    opts.requestText !== undefined &&
    opts.requestText !== opts.text &&
    opts.clientMessageId !== undefined
  ) {
    extras.rewrite_for = opts.clientMessageId;
  }

  if (
    (extras.media === undefined || extras.media.length === 0) &&
    (extras.topic === undefined || extras.topic.length === 0) &&
    extras.rewrite_for === undefined
  ) {
    return undefined;
  }
  return extras;
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

  // The signal we hand to `sendMessageV1`. The lifecycle handler resolves
  // it on `turn/completed` or `turn/error` (or on early failure inside
  // `sendMessageV1`). The next chained call awaits this signal before
  // issuing its own `bridge.sendTurn`.
  let release!: () => void;
  const lifecycleDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Build the chain entry as a fresh promise we keep a stable reference to,
  // so the cleanup compare-and-delete is correct. Issue #109.1: the chain
  // entry must be installed SYNCHRONOUSLY (before the bridge-start await)
  // so that rapid back-to-back sendMessage() calls observe each other in
  // `turnQueues.get(key)` and serialise correctly. Pre-fix, awaiting the
  // bridge start before `turnQueues.set` let two rapid sends each read
  // `Promise.resolve()` as their `prev`, defeating the per-session FIFO.
  const chained = prev.then(() => lifecycleDone);
  turnQueues.set(key, chained);

  try {
    await prev;
    // Issue #109.1: ensure the bridge is usable BEFORE mutating
    // ThreadStore / firing `onSessionActive`. Pre-fix, the optimistic
    // row + session-active callback ran unconditionally, so a failed
    // bridge start left an orphan user bubble + an "active" session
    // row that never reached JSONL. `startBridgeForSession` is
    // idempotent for same-scope already-started bridges so the happy
    // path stays cheap.
    try {
      await startBridgeForSession(
        pinnedOpts.sessionId,
        pinnedOpts.historyTopic,
      );
    } catch {
      if (typeof console !== "undefined" && console.warn) {
        console.warn(
          "ui-protocol-send: bridge start failed; aborting optimistic projection",
        );
      }
      pinnedOpts.onComplete?.();
      release();
      return;
    }

    // Codex round 4-6 P2: mirror the user message into ThreadStore
    // before issuing `sendTurn`, so the bubble is visible the instant
    // the bridge is confirmed available. The mirror runs once per
    // send; the WS path's own listener never re-mirrors.
    const localFiles = pinnedOpts.media.map((path) => ({
      filename: displayFilenameFromPath(path),
      path,
      caption: "",
    }));
    // M9-γ-4: Composer renders a `<GhostBubble>` overlay under
    // projection_v1; it pre-registers the cmid so the first
    // server-side envelope on this thread carries it (the projection
    // captures it into `UserView.client_message_id` so the ghost can
    // match-and-unmount). Skip the legacy reducer mutation so the
    // ThreadStore stays free of an optimistic row.
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

    // M9-β-1 (UPCR-2026-015 / server PR #860): the three previously
    // unsupported variants — media-bearing, /queue-rewrite, and
    // topic-scoped sends — are now first-class on the WS path.
    // `sendMessageV1` builds a `TurnStartExtras` envelope from the
    // populated `SendOptions` fields and the bridge serialises only
    // the populated extras onto the wire (so the on-wire shape stays
    // byte-identical to a pre-β-1 build for text-only sends).
    await sendMessageV1(pinnedOpts, release);
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
  // Codex BLOCK F: track whether `turn/started` has arrived for this
  // turn. If a `BridgeStoppedError` from `sendTurn` lands after the
  // server accepted the turn (its `turn/started` notification reached
  // us before the transport dropped), we should NOT impose a 45s
  // ceiling on the wait — the turn is already running server-side, and
  // its `turn/completed` will arrive via the normal lifecycle channel.
  let turnStartedSeen = false;
  // Cancel handle for the BridgeStoppedError grace timer. Surfaced
  // here so the `turn/started` handler can clear it as soon as the
  // server's ack arrives during the grace window.
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  // Latest known connection state. Used at the moment of an error to
  // distinguish terminal `closed`/`error` (finalize immediately) from
  // mid-flight `reconnecting` (apply the grace window so an
  // accepted-but-not-acked turn can complete via the lifecycle
  // channel after reconnect). Codex round-2 BLOCK F: seed from the
  // bridge synchronously. `onConnectionStateChange` only fires on
  // TRANSITIONS, so seeding `"connected"` masks the case where the
  // bridge is ALREADY terminal at send-start — a sync
  // `BridgeStoppedError` would then take the 45s grace path instead
  // of fast-rejecting. `getActiveBridge` no longer gates on
  // `connectionState === "connected"` (runtime change for M10.5
  // Wave A round-3), so this can happen in practice.
  let lastConnState: string = bridge.getConnectionState();
  const fireComplete = () => {
    if (completed) return;
    completed = true;
    if (lifecycleSafetyTimer !== null) {
      clearTimeout(lifecycleSafetyTimer);
      lifecycleSafetyTimer = null;
    }
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
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
    // We fire on `completed` and `error`; `started` cancels the grace
    // window (codex BLOCK F) so a long-running accepted turn doesn't
    // get errored out by the 45s ceiling.
    if ("error" in e) {
      off();
      fireComplete();
      return;
    }
    if ("reason" in e) {
      off();
      fireComplete();
      return;
    }
    // Bare `turn/started`: server accepted the turn. If we're in a
    // BridgeStoppedError grace wait, cancel it — the lifecycle channel
    // (and the 15-min safety timer) is now the only thing that can
    // finalize the bubble.
    turnStartedSeen = true;
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
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
    lastConnState = s;
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
    // M9-β-1 (UPCR-2026-015): build the `TurnStartExtras` envelope
    // from the populated `SendOptions` fields. The bridge serialises
    // only the populated extras onto the wire, so a text-only send
    // produces the same bytes a pre-β-1 build did.
    const extras = buildTurnStartExtras(opts);
    const result = await bridge.sendTurn(
      clientMessageId,
      [{ kind: "text", text }],
      extras,
    );
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
  } catch (err) {
    // Issue #109.3 / codex BLOCK F: distinguish "reconnectable
    // mid-flight transport drop" from "terminal fast-reject":
    //
    //  - Terminal `BridgeStoppedError` (bridge transitioned to
    //    `closed` or `error`+abandoned): finalize the bubble
    //    immediately. The bridge will not re-deliver the lifecycle.
    //    Pre-fix every BridgeStoppedError took the 45s ceiling,
    //    which made auth-denied / validation-error fast-rejects
    //    sit for 45s for no reason.
    //
    //  - Reconnectable `BridgeStoppedError` (state still
    //    `reconnecting` / `connecting` — the bridge is going to
    //    try again): wait the grace window. If `turn/started`
    //    arrived during the wait, the lifecycle handler cancels
    //    `graceTimer` and the 15-min safety timer becomes the
    //    only ceiling (which is what we want for legitimately
    //    long-running accepted turns).
    //
    //  - `turn/started` already seen: do NOT impose any grace
    //    ceiling. The server accepted the turn; the lifecycle
    //    channel is the source of truth.
    //
    //  - Non-`BridgeStoppedError` (RPC permission_denied,
    //    validation error, etc.): finalize immediately.
    const finalizeAsError = () => {
      if (completed) return;
      ThreadStore.finalizeAssistant(clientMessageId, { status: "error" });
      off();
      fireComplete();
    };
    const isTransportClose = err instanceof BridgeStoppedError;
    const terminalConnState =
      lastConnState === "closed" || lastConnState === "error";
    if (isTransportClose && !turnStartedSeen && !terminalConnState) {
      // Reconnectable mid-flight drop: give the bridge a chance to
      // reconnect and deliver `turn/started` via lifecycle.
      graceTimer = setTimeout(() => {
        graceTimer = null;
        finalizeAsError();
      }, 45_000);
    } else if (isTransportClose && turnStartedSeen) {
      // Server accepted the turn before the transport dropped.
      // Don't finalize — the 15-min safety timer + the lifecycle
      // channel will handle completion (or release the gate on
      // bridge teardown via offState).
    } else {
      finalizeAsError();
    }
    // Token may have been rejected at WS upgrade — probe `/api/auth/me`
    // to surface dead-token cases via api/client's 401 interceptor (which
    // hard-redirects to /login). If the token is still good, this is a
    // no-op and the user can retry.
    probeAuthAfterSendFailure();
  }
}
