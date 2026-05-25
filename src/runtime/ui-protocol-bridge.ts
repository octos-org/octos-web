/**
 * UI Protocol v1 client bridge for /chat (Phase C-1).
 *
 * Strict, fail-closed adapter around the JSON-RPC over WebSocket transport
 * served at `/api/ui-protocol/ws`. Pure adapter: no rendering, no store
 * mutations. Phase C-2 wires it into the existing runtime; this PR only
 * lands the bridge surface plus tests.
 *
 * Failure mode: required fields missing on a notification surface as a
 * `warning` event and the notification is dropped. Synthesizing UUIDs
 * defeats the entire point of the strict typing — the prior /coding bridge
 * (PR #63, BLOCKed by codex review) had `turn_id?: string` and a synthetic
 * fallback, which is exactly the M8.10 thread-binding bug class.
 */

import { getToken, getSelectedProfileId } from "@/api/client";
import { TOKEN_KEY, ADMIN_TOKEN_KEY } from "@/lib/constants";
import {
  AUX_REST_TO_WS_V1_FEATURE,
  isAuxRestToWsV1Enabled,
} from "@/lib/feature-flags";
import type {
  ApprovalDecision,
  ApprovalRequestedEvent,
  ApprovalRespondResult,
  ApprovalScope,
  ConnectionState,
  HydratedMessage,
  MessageDeltaEvent,
  FileAttachedEvent,
  MessagePersistedEvent,
  ProgressUpdatedEvent,
  QueueStateEvent,
  RouterFailoverEvent,
  RouterStatusEvent,
  RpcErrorPayload,
  SessionHydrateResult,
  SessionOpenResult,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  ToolCompletedEvent,
  ToolProgressEvent,
  ToolStartedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnInterruptResult,
  TurnSpawnCompleteEvent,
  TurnStartExtras,
  TurnStartInput,
  TurnStartResult,
  TurnStartedEvent,
  UiProgressMetadata,
  UiRetryBackoff,
  UiTokenCostUpdate,
  UiFileMutationNotice,
  WarningEvent,
} from "./ui-protocol-types";

export type {
  ApprovalDecision,
  ApprovalRequestedEvent,
  ApprovalRespondResult,
  ApprovalScope,
  ConnectionState,
  HydratedMessage,
  MessageDeltaEvent,
  MessagePersistedEvent,
  PersistedMessage,
  PersistedMessageFile,
  ProgressUpdatedEvent,
  QueueStateEvent,
  RouterFailoverEvent,
  RouterStatusEvent,
  SessionHydrateResult,
  SessionOpenResult,
  SessionOpenedResult,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  ToolCompletedEvent,
  ToolProgressEvent,
  ToolStartedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnInterruptResult,
  TurnSpawnCompleteEvent,
  FileAttachedEvent,
  TurnStartExtras,
  TurnStartInput,
  TurnStartMediaRef,
  TurnStartResult,
  TurnStartedEvent,
  UiCursor,
  UiFileMutationNotice,
  UiProgressMetadata,
  UiRetryBackoff,
  UiTokenCostUpdate,
  WarningEvent,
} from "./ui-protocol-types";

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

export const UI_PROTOCOL_WS_PATH = "/api/ui-protocol/ws";

export const METHODS = {
  // client → server
  SESSION_OPEN: "session/open",
  SESSION_HYDRATE: "session/hydrate",
  TURN_START: "turn/start",
  TURN_INTERRUPT: "turn/interrupt",
  APPROVAL_RESPOND: "approval/respond",
  TASK_OUTPUT_READ: "task/output/read",
  DIFF_PREVIEW_GET: "diff/preview/get",
  TURN_STATE_GET: "turn/state/get",
  PING: "ping",
  // M12 Phase D-1 (octos PR #912): auxiliary.rest_to_ws.v1 methods.
  // Each mirrors the JSON body of the corresponding REST handler so
  // the WS path can stand in 1:1 for the REST callsite when the
  // client-side `auxiliary_rest_to_ws_v1` feature flag is on.
  SESSION_LIST: "session/list",
  SESSION_SNAPSHOT: "session/snapshot",
  SESSION_MESSAGES_PAGE: "session/messages_page",
  SESSION_STATUS_GET: "session/status.get",
  SESSION_FILES_LIST: "session/files.list",
  SESSION_TASKS_LIST: "session/tasks.list",
  SESSION_WORKSPACE_GET: "session/workspace.get",
  SESSION_TITLE_SET: "session/title.set",
  SESSION_DELETE: "session/delete",
  SYSTEM_STATUS_GET: "system/status.get",
  CONTENT_LIST: "content/list",
  CONTENT_DELETE: "content/delete",
  CONTENT_BULK_DELETE: "content/bulk_delete",
  // server → client
  MESSAGE_DELTA: "message/delta",
  MESSAGE_PERSISTED: "message/persisted",
  TASK_UPDATED: "task/updated",
  TASK_OUTPUT_DELTA: "task/output/delta",
  TURN_STARTED: "turn/started",
  TURN_COMPLETED: "turn/completed",
  TURN_ERROR: "turn/error",
  TURN_SPAWN_COMPLETE: "turn/spawn_complete",
  // UPCR-2026-014 M9-α-9: dedicated per-artefact envelope emitted by the
  // server alongside the media carriers on message/persisted /
  // turn/spawn_complete. The runtime routes this through
  // ThreadStore.appendFileAttachment so the bubble's <FileAttachment>
  // row renders even when the richer-envelope reducers miss the
  // placement (slides soak 2026-05-24 failure mode).
  FILE_ATTACHED: "file/attached",
  APPROVAL_REQUESTED: "approval/requested",
  WARNING: "warning",
  // Synchronous tool-call lifecycle. Server emits these as
  // `UiNotification::ToolStarted/Progress/Completed` for non-spawn tool
  // calls. The event-router fans them out into the legacy
  // `crew:tool_progress` DOM event so the streaming-bubble spinner
  // (`ToolProgressIndicator`) lights up — the SSE bridge predecessor of
  // this surface was the sole dispatcher prior to PR #96. See
  // `crates/octos-cli/src/api/ui_protocol_progress.rs:99-363`.
  TOOL_STARTED: "tool/started",
  TOOL_PROGRESS: "tool/progress",
  TOOL_COMPLETED: "tool/completed",
  /// Generic progress envelope — server uses this for cost / status /
  /// retry / file-mutation frames. The event-router fans `kind ===
  /// "token_cost_update"` notifications out into `crew:cost` (header
  /// model + cost badge) and, when model + duration are populated, also
  /// `crew:message_meta` (assistant bubble footer).
  PROGRESS_UPDATED: "progress/updated",
  // M12 Phase D-3 (octos-web #106 review follow-up): server emits
  // `session/title-updated` after a successful `session/title.set` so
  // cross-tab / auto-title flows can refresh their cache without polling
  // the REST list. See the M12 Phase D ADR.
  SESSION_TITLE_UPDATED: "session/title-updated",
  // Wave4-A (server PR #946) adaptive router surface. Server pushes
  // `router/status` adjacent to `turn/started` and `turn/completed` so
  // the SPA can render the routing pill / lane debug view without
  // polling; `router/failover` fires once when the adaptive router
  // crosses lanes mid-turn.  `queue/state` is the client-emitted
  // counterpart for the per-session FIFO that lives in
  // `ui-protocol-send.ts`; the variant exists on the wire so other
  // clients can observe queue depth uniformly. Client-issued RPCs:
  // `router/set_mode` toggles the active adaptive mode at runtime and
  // `router/get_metrics` snapshots the same payload `router/status`
  // pushes for on-demand reads.
  ROUTER_STATUS: "router/status",
  ROUTER_FAILOVER: "router/failover",
  QUEUE_STATE: "queue/state",
  ROUTER_SET_MODE: "router/set_mode",
  ROUTER_GET_METRICS: "router/get_metrics",
} as const;

/**
 * Static base capability list — always negotiated.
 *
 * The full negotiated list at runtime is computed by
 * `getUiProtocolFeatures()`, which appends opt-in capabilities
 * controlled by client-side feature flags (`auxiliary.rest_to_ws.v1`
 * under `octos_auxiliary_rest_to_ws_v1`).
 */
export const UI_PROTOCOL_FEATURES = [
  "approval.typed.v1",
  "pane.snapshots.v1",
  // P1.3 (server PR #767, web PR aligning the wire shape): the server
  // explicitly filters both live broadcast and cursor replay of
  // `message/persisted` notifications unless this capability was
  // negotiated at session/open. Without this feature in the
  // `ui_feature` query, the bridge's new media-aware
  // `guardMessagePersisted` + `handleMessagePersisted` path is
  // unreachable in production. See server `ui_protocol.rs:1941` and
  // `ui_protocol.rs:2075` for the gating logic.
  "event.message_persisted.v1",
  // M10 Phase 1 (server PR #772): server only emits the new
  // `turn/spawn_complete` envelope when this capability is negotiated at
  // session/open. Without it, late `spawn_only` results continue to flow
  // through the legacy `message/persisted` row (and the splice-merge
  // predicate in ThreadStore). Phase 5 will delete the legacy path; this
  // PR (Phase 2) only ADDS the new envelope handling so the migration is
  // backward-compatible during rollout.
  "event.spawn_complete.v1",
  // UPCR-2026-014 M9-α-9 (server commit landing alongside this web PR):
  // dedicated `file/attached` envelope per delivered artefact from any
  // `spawn_only` background tool (mofa_slides, podcast_generate,
  // fm_tts, deep_search, mofa_*). Runs alongside the existing media
  // carriers on `message/persisted` / `turn/spawn_complete` as a
  // redundant wire signal — when the richer envelopes' placement
  // logic drops a delivery (slides soak 2026-05-24: PPTX on disk but
  // no button on SPA), the dedicated envelope ensures the user still
  // sees the file. Server only emits the envelope to connections that
  // negotiated this capability.
  "event.file_attached.v1",
  // M10 Phase 6.2 (server PR #791 / Bug C): server gates `session/hydrate`
  // RPC behind this feature when feature negotiation is present (UPCR-2026-009).
  // Without it, our hydrate dedup pass never runs because the server
  // returns `method_not_supported` for the RPC. The dedup snapshot
  // populated post-`session/open` from the negotiated `replayed_envelopes`
  // is what eliminates the N+1 bubble render after page reload.
  "state.session_hydrate.v1",
] as const;

/**
 * Resolve the live `ui_feature` capability list to send on the WS open
 * query. Adds opt-in capabilities gated on client-side feature flags.
 *
 * M12 Phase D-2 (octos PR #912 / octos-web #103): when the
 * `octos_auxiliary_rest_to_ws_v1` localStorage flag is on, append
 * `auxiliary.rest_to_ws.v1`. Without that capability in the WS query,
 * the server advertises the 13 aux methods in `SessionOpened.capabilities`
 * but the dispatcher rejects every call (octos #913 — server polish
 * follow-up). The client must negotiate properly regardless of that
 * server bug, so the flag explicitly controls inclusion here.
 *
 * Tests can override the full list via `BridgeConfig.features`.
 */
export function getUiProtocolFeatures(): readonly string[] {
  const base: string[] = [...UI_PROTOCOL_FEATURES];
  if (isAuxRestToWsV1Enabled()) {
    base.push(AUX_REST_TO_WS_V1_FEATURE);
  }
  return base;
}

const JSON_RPC_VERSION = "2.0";

// Backoff schedule per task spec: 1s, 2s, 4s, 8s, 16s, 30s, then capped at 30s.
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
const RECONNECT_BACKOFF_CAP_MS = 30000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 8;
const DEFAULT_RPC_TIMEOUT_MS = 30000;
const DEFAULT_SEND_QUEUE_LIMIT = 64;
const DEFAULT_KEEPALIVE_MS = 30000;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 60000;
const NORMAL_CLOSURE = 1000;

// Spec §10 `permission_denied` (`crates/octos-core/src/ui_protocol.rs`
// `PERMISSION_DENIED: i64 = -32120`). When the server rejects
// `session/open` or `turn/start` with this RPC code, the token is
// effectively dead for the chat surface — surface `crew:auth_expired`
// so AuthProvider can revalidate / drop the user back to /login.
const RPC_ERROR_PERMISSION_DENIED = -32120;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class BridgeStoppedError extends Error {
  constructor(message = "ui-protocol-bridge stopped") {
    super(message);
    this.name = "BridgeStoppedError";
  }
}

export class BridgeRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(`rpc-error[${code}] ${message}`);
    this.name = "BridgeRpcError";
    this.code = code;
    this.data = data;
  }
}

export class BridgeTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`rpc timeout: ${method} after ${timeoutMs}ms`);
    this.name = "BridgeTimeoutError";
  }
}

export interface UiProtocolBridge {
  /** Start the bridge. The optional `topic` arg is used purely client-side
   *  to drop event envelopes whose `params.topic` carries a different
   *  topic (codex BLOCK E). Until the server scopes its replay/live
   *  broadcast to the negotiated topic (separate server PR), this is
   *  best-effort defense — only events whose Rust struct includes the
   *  `topic` field carry it on the wire (e.g. `TurnStartedEvent`); other
   *  envelopes pass through unfiltered. */
  start(opts: {
    sessionId: string;
    profileId?: string;
    topic?: string;
  }): Promise<void>;
  stop(): Promise<void>;

  sendTurn(
    turn_id: string,
    input: TurnStartInput[],
    /** UPCR-2026-015 (M9-β-1): optional `media`, `topic`,
     *  `rewrite_for` extras carried alongside `input`. Each is
     *  forwarded onto the wire only when populated; omitted entirely
     *  for legacy text-only sends so the on-wire shape stays
     *  byte-identical to a pre-β-1 build. */
    extras?: TurnStartExtras,
  ): Promise<TurnStartResult>;
  interruptTurn(turn_id: string, reason?: string): Promise<TurnInterruptResult>;
  respondToApproval(
    approval_id: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    client_note?: string,
  ): Promise<ApprovalRespondResult>;

  /**
   * Issue a `session/hydrate` RPC for the active session. M10 Phase 6.2
   * (Bug C): `replayed_envelopes` + per-row `(message_id, source)` are
   * surfaced only when the connection negotiated
   * `event.spawn_complete.v1` (server PR #791). Used by the runtime
   * layer to dedup the legacy `Background`-source rows the live wire
   * suppresses for negotiated clients.
   *
   * `include` defaults to `["messages"]` — that's the dedup target.
   * Returns `null` when the RPC fails: the caller falls back to the
   * legacy REST `replayHistory` path with no hydrate-time dedup.
   */
  hydrateSession(
    include?: ReadonlyArray<"messages" | "threads" | "turns" | "pending_approvals">,
  ): Promise<SessionHydrateResult | null>;

  /**
   * Generic JSON-RPC request escape hatch.
   *
   * Used by the auxiliary wrappers in `src/api/sessions.ts` and
   * `src/api/content.ts` for the methods that share the same WS
   * connection as the chat bridge. The dedicated typed methods above
   * (`sendTurn`, `interruptTurn`, ...) remain the only entry points
   * for the chat lifecycle; this escape hatch is intentionally
   * untyped so each wrapper can own its own request/response DTOs
   * without bloating the bridge surface.
   *
   * Rejects with `BridgeRpcError` when the server returns a JSON-RPC
   * error envelope, with `BridgeTimeoutError` if the response exceeds
   * the bridge's per-RPC timeout, and with `BridgeStoppedError` when
   * the connection is closed or the bridge has given up reconnecting.
   */
  callMethod<T = unknown>(method: string, params?: unknown): Promise<T>;

  onMessageDelta(handler: (e: MessageDeltaEvent) => void): () => void;
  onMessagePersisted(handler: (e: MessagePersistedEvent) => void): () => void;
  onSpawnComplete(handler: (e: TurnSpawnCompleteEvent) => void): () => void;
  /** UPCR-2026-014 M9-α-9 dedicated per-artefact envelope subscriber.
   *  Routes one event per `file/attached` notification — the SPA
   *  reducer attaches the file to the bubble that hosts
   *  `tool_call_id` (preferred) or `turn_id` (fallback). Slides soak
   *  redundancy: even when the richer envelopes' media arrays land
   *  but the placement reducer drops them, this signal lets the
   *  bubble surface a clickable button. */
  onFileAttached(handler: (e: FileAttachedEvent) => void): () => void;
  onTaskUpdated(handler: (e: TaskUpdatedEvent) => void): () => void;
  onTaskOutputDelta(handler: (e: TaskOutputDeltaEvent) => void): () => void;
  onTurnLifecycle(
    handler: (
      e: TurnStartedEvent | TurnCompletedEvent | TurnErrorEvent,
    ) => void,
  ): () => void;
  onApprovalRequested(handler: (e: ApprovalRequestedEvent) => void): () => void;
  /** Synchronous tool-call lifecycle event surface. The event-router
   *  attaches a handler that re-emits each variant as a
   *  `crew:tool_progress` DOM event so the streaming-bubble spinner keeps
   *  firing post-PR-#96 SSE-bridge deletion. */
  onToolStarted(handler: (e: ToolStartedEvent) => void): () => void;
  onToolProgress(handler: (e: ToolProgressEvent) => void): () => void;
  onToolCompleted(handler: (e: ToolCompletedEvent) => void): () => void;
  /** Generic progress envelope subscriber. The event-router fans
   *  `metadata.kind === "token_cost_update"` notifications out into the
   *  legacy `crew:cost` and (model + duration permitting) `crew:message_meta`
   *  DOM events so the header cost badge and assistant-bubble footer
   *  keep firing post-PR-#96 SSE-bridge deletion. */
  onProgressUpdated(handler: (e: ProgressUpdatedEvent) => void): () => void;
  /** Wave4-A `router/status` subscriber. The event-router fans this
   *  out into the `crew:mode_update` DOM event so `useModeState()` in
   *  `session-context.tsx:127` lights the toolbar pill. */
  onRouterStatus(handler: (e: RouterStatusEvent) => void): () => void;
  /** Wave4-A `router/failover` subscriber. The event-router dispatches
   *  a `crew:router_failover` DOM event so the chat-layout can surface
   *  a transient banner. */
  onRouterFailover(handler: (e: RouterFailoverEvent) => void): () => void;
  /** Wave4-A `queue/state` subscriber. Symmetric with the other
   *  notification surfaces — `ui-protocol-send.ts` self-dispatches
   *  these through a window CustomEvent (the queue is client-side
   *  today), but the bridge still routes server-emitted variants for
   *  forward compatibility. */
  onQueueState(handler: (e: QueueStateEvent) => void): () => void;
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
  /** Codex BLOCK F: synchronous read of the bridge's current
   *  connection state. The `onConnectionStateChange` listener fires on
   *  TRANSITIONS, so a subscriber installed AFTER the bridge is
   *  already terminal never sees the entry-state. Send-path callers
   *  read this at send-start so a `BridgeStoppedError` raised before
   *  the listener fires can be classified as terminal-fast-reject
   *  (skip the 45s grace) vs reconnectable. */
  getConnectionState(): ConnectionState;
  /** Fires every time `session/open` is successfully acked AFTER the
   *  initial open in this bridge lifecycle — i.e. on every RECONNECT.
   *  The initial open does NOT fire this event because the runtime
   *  layer already hydrates immediately after `startBridgeForSession`.
   *
   *  The reload-bug fix (Yue 2026-05-15): when the user's WS drops
   *  during a long-running `spawn_only` and the bridge reconnects, the
   *  server's `session/open` without an `after` cursor serves "live
   *  only, no replay" (`ui_protocol_ledger.rs:1199`). Any envelopes the
   *  server emitted between disconnect and reconnect are silently
   *  dropped. Subscribers (the runtime layer) re-issue
   *  `bridge.hydrateSession(["messages"])` on this event to recover the
   *  missed completion bubble + media attachment from the durable
   *  ledger via `replayed_envelopes`. */
  onReopened(handler: () => void): () => void;
  onWarning(handler: (e: WarningEvent) => void): () => void;
  /** Issue #113.2: server-emitted title update for cross-tab and
   *  auto-title flows. SessionProvider subscribes to keep its
   *  `titleCache` and `sessions[]` in sync. */
  onSessionTitleUpdated(
    handler: (e: { session_id: string; title: string }) => void,
  ): () => void;
}

export interface BridgeConfig {
  /** Override the WS endpoint origin. Defaults to `window.location.origin`. */
  origin?: string;
  /** Override the auth token resolver (test/SSR injection). */
  getToken?: () => string | null;
  /** Override the profile resolver (test/SSR injection). */
  getProfileId?: () => string | null;
  /** Override `WebSocket` constructor (test injection). */
  webSocketImpl?: typeof WebSocket;
  /** Override the UUID generator (test injection). */
  generateId?: () => string;
  /** Override the timer scheduler (test injection — vitest fake timers). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Override `Date.now()` (test injection). */
  now?: () => number;
  /** Override the negotiated `ui_feature` capability list. */
  features?: readonly string[];
  /** Per-RPC timeout. Default 30s. */
  rpcTimeoutMs?: number;
  /** Send queue cap before oldest entries are dropped. Default 64. */
  sendQueueLimit?: number;
  /** Reconnect attempts before the bridge transitions to `error`. Default 8. */
  maxReconnectAttempts?: number;
  /** Keepalive interval in `'connected'` state. Default 30s. */
  keepaliveIntervalMs?: number;
  /** Silence threshold before a keepalive triggers reconnect. Default 60s. */
  keepaliveTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Wire envelope shapes
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: RpcErrorPayload;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/**
 * Queued WS frame. Issue #109.2: RPC frames are tagged with their
 * request id so that an RPC timeout / cancellation can remove the
 * matching frame from `sendQueue` instead of leaving it parked to
 * re-fire after reconnect. Plain notifications (no `id`) flush
 * normally.
 */
interface QueuedFrame {
  text: string;
  rpcId?: string;
}

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: unknown;
}

type Listener<T> = (value: T) => void;

class Subscribers<T> {
  private readonly handlers: Set<Listener<T>> = new Set();

  add(handler: Listener<T>): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(value: T): void {
    for (const h of [...this.handlers]) {
      try {
        h(value);
      } catch {
        // Subscriber errors must not break dispatch; the bridge swallows
        // them so a buggy listener can't poison sibling subscribers.
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

// ---------------------------------------------------------------------------
// Type guards (fail-closed)
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function guardMessageDelta(p: unknown): MessageDeltaEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id) || !isString(p.turn_id)) return null;
  // Server-side wire field is `text` (see
  // `octos_core::ui_protocol::MessageDeltaEvent`). The previous guard
  // required `params.delta` and silently rejected every real frame —
  // the M10 Phase 6.2 root cause that left the spawn-ack pending
  // empty. Accept `text` and surface it as `event.text` to the router.
  if (typeof p.text !== "string") return null;
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    text: p.text,
    message_id: typeof p.message_id === "string" ? p.message_id : undefined,
  };
}

function guardMessagePersisted(p: unknown): MessagePersistedEvent | null {
  // Validates the flat `UPCR-2026-012` wire shape. Earlier versions of this
  // guard expected a nested `{ message: { id, thread_id, content, role } }`
  // payload that no real server has ever sent — it would reject every
  // production event. This rewrite accepts what the server actually emits.
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id)) return null;
  if (typeof p.seq !== "number" || !Number.isFinite(p.seq) || p.seq < 0) {
    return null;
  }
  if (!isString(p.message_id) || !p.message_id) return null;
  if (
    p.role !== "system" &&
    p.role !== "user" &&
    p.role !== "assistant" &&
    p.role !== "tool"
  ) {
    return null;
  }
  if (
    p.source !== "user" &&
    p.source !== "assistant" &&
    p.source !== "tool" &&
    p.source !== "background" &&
    p.source !== "recovery"
  ) {
    return null;
  }
  if (
    !isPlainObject(p.cursor) ||
    typeof p.cursor.seq !== "number" ||
    !Number.isFinite(p.cursor.seq) ||
    p.cursor.seq < 0 ||
    !isString(p.cursor.stream)
  ) {
    return null;
  }
  if (!isString(p.persisted_at)) return null;
  // Optional fields — present-shape-checked but not required.
  const turn_id =
    typeof p.turn_id === "string" && p.turn_id.length > 0 ? p.turn_id : undefined;
  const thread_id =
    typeof p.thread_id === "string" && p.thread_id.length > 0
      ? p.thread_id
      : undefined;
  const client_message_id =
    typeof p.client_message_id === "string" && p.client_message_id.length > 0
      ? p.client_message_id
      : undefined;
  let media: string[] | undefined;
  if (Array.isArray(p.media)) {
    const filtered = p.media.filter((u): u is string => isString(u) && u.length > 0);
    if (filtered.length > 0) media = filtered;
  }
  // 2026-05-19: server now emits the persisted row's text content on
  // the wire (`content`, omitted when empty) so the SPA can surface
  // captions / summaries alongside `media`. Accept the field here so
  // the router sees it; pre-fix the guard stripped it and the router
  // wrote `""` to the bubble even when content was present on the wire.
  const content =
    typeof p.content === "string" && p.content.length > 0 ? p.content : undefined;
  return {
    session_id: p.session_id,
    turn_id,
    thread_id,
    seq: p.seq,
    role: p.role,
    message_id: p.message_id,
    client_message_id,
    source: p.source,
    cursor: { stream: p.cursor.stream, seq: p.cursor.seq },
    persisted_at: p.persisted_at,
    media,
    content,
  };
}

function guardSpawnComplete(p: unknown): TurnSpawnCompleteEvent | null {
  // M10 Phase 1 envelope. Required-field invariants per the server-side
  // `TurnSpawnCompleteEvent` struct (`crates/octos-core/src/ui_protocol.rs`):
  //   - session_id, task_id, message_id, source, persisted_at — non-empty strings
  //   - seq                                                    — finite non-negative number
  //   - cursor.{stream, seq}                                   — non-empty string + finite number
  //   - content                                                — REQUIRED non-empty string
  //   - turn_id, thread_id, response_to_client_message_id      — optional strings
  //   - media                                                  — optional string[]
  //
  // The `content` non-empty check is the load-bearing distinguisher from
  // a spawn-ack `message/persisted` row whose content is a short ack
  // message — a `turn/spawn_complete` with empty content is either a
  // server bug or the wrong wire shape entirely; either way, fail closed.
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id)) return null;
  if (!isString(p.task_id)) return null;
  if (typeof p.seq !== "number" || !Number.isFinite(p.seq) || p.seq < 0) {
    return null;
  }
  if (!isString(p.message_id)) return null;
  if (!isString(p.source)) return null;
  if (
    !isPlainObject(p.cursor) ||
    typeof p.cursor.seq !== "number" ||
    !Number.isFinite(p.cursor.seq) ||
    p.cursor.seq < 0 ||
    !isString(p.cursor.stream)
  ) {
    return null;
  }
  if (!isString(p.persisted_at)) return null;
  // `content` must BE A STRING (present, correct type). It MAY be empty
  // when `media` is non-empty — that's the file-only completion path
  // (server-side spawn_only tool whose result is purely artefactual).
  // Codex round-4 P2 caught this: rejecting empty-content envelopes
  // would silently drop file-only completions for upgraded clients,
  // because the server suppresses the legacy `message/persisted`
  // fallback once `event.spawn_complete.v1` is negotiated.
  if (typeof p.content !== "string") return null;

  let media: string[] | undefined;
  if (Array.isArray(p.media)) {
    const filtered = p.media.filter(
      (u): u is string => isString(u) && u.length > 0,
    );
    if (filtered.length > 0) media = filtered;
  }
  // Reject only when BOTH content and media are empty — truly nothing
  // to render, which is a server bug (the original spec's "distinguish
  // from spawn-ack" intent is now enforced by the `turn/spawn_complete`
  // method name rather than by content non-emptiness).
  if (p.content.length === 0 && (!media || media.length === 0)) {
    return null;
  }
  return {
    session_id: p.session_id,
    turn_id:
      typeof p.turn_id === "string" && p.turn_id.length > 0
        ? p.turn_id
        : undefined,
    thread_id:
      typeof p.thread_id === "string" && p.thread_id.length > 0
        ? p.thread_id
        : undefined,
    task_id: p.task_id,
    // Parallel server PR adds `tool_call_id` so the originating LLM
    // tool call can be flipped to "complete" without the TaskStore
    // race. Optional for forward compatibility with legacy daemons.
    tool_call_id:
      typeof p.tool_call_id === "string" && p.tool_call_id.length > 0
        ? p.tool_call_id
        : undefined,
    response_to_client_message_id:
      typeof p.response_to_client_message_id === "string" &&
      p.response_to_client_message_id.length > 0
        ? p.response_to_client_message_id
        : undefined,
    seq: p.seq,
    message_id: p.message_id,
    source: p.source,
    cursor: { stream: p.cursor.stream, seq: p.cursor.seq },
    persisted_at: p.persisted_at,
    content: p.content,
    media,
  };
}

/**
 * UPCR-2026-014 M9-α-9 `file/attached` envelope guard. Fail-closed on
 * required-field violations matching the server-side `FileAttachedEvent`
 * struct (`crates/octos-core/src/ui_protocol.rs`):
 *
 *   - session_id    — non-empty string
 *   - turn_id       — non-empty string
 *   - path          — non-empty string
 *   - tool_call_id  — optional non-empty string
 *   - mime          — optional non-empty string
 *
 * Surfaces the envelope to subscribers only when ALL placement context
 * (turn_id + path) is present; orphan envelopes that would mint a
 * placeholder bubble are dropped instead.
 */
function guardFileAttached(p: unknown): FileAttachedEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id)) return null;
  if (!isString(p.turn_id)) return null;
  if (!isString(p.path)) return null;
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    path: p.path,
    tool_call_id:
      typeof p.tool_call_id === "string" && p.tool_call_id.length > 0
        ? p.tool_call_id
        : undefined,
    mime:
      typeof p.mime === "string" && p.mime.length > 0 ? p.mime : undefined,
  };
}

/**
 * Guard for one row in `SessionHydrateResult.messages`. Fail-closed on
 * type / required-field violations. `message_id` and `source` are
 * Option<String> on the wire (server PR #791 codex round 6 gates them
 * on `event.spawn_complete.v1` negotiation), so absence is normal — we
 * surface them as `undefined` rather than rejecting the row.
 */
function guardHydratedMessage(p: unknown): HydratedMessage | null {
  if (!isPlainObject(p)) return null;
  if (typeof p.seq !== "number" || !Number.isFinite(p.seq) || p.seq < 0) {
    return null;
  }
  if (!isString(p.role)) return null;
  if (
    p.role !== "system" &&
    p.role !== "user" &&
    p.role !== "assistant" &&
    p.role !== "tool"
  ) {
    return null;
  }
  if (typeof p.content !== "string") return null;
  if (!isString(p.persisted_at)) return null;
  let media: string[] | undefined;
  if (Array.isArray(p.media)) {
    const filtered = p.media.filter(
      (u): u is string => isString(u) && u.length > 0,
    );
    if (filtered.length > 0) media = filtered;
  }
  return {
    seq: p.seq,
    role: p.role,
    content: p.content,
    turn_id:
      typeof p.turn_id === "string" && p.turn_id.length > 0
        ? p.turn_id
        : undefined,
    thread_id:
      typeof p.thread_id === "string" && p.thread_id.length > 0
        ? p.thread_id
        : undefined,
    client_message_id:
      typeof p.client_message_id === "string" && p.client_message_id.length > 0
        ? p.client_message_id
        : undefined,
    persisted_at: p.persisted_at,
    message_id:
      typeof p.message_id === "string" && p.message_id.length > 0
        ? p.message_id
        : undefined,
    source:
      typeof p.source === "string" && p.source.length > 0
        ? p.source
        : undefined,
    media,
  };
}

/**
 * Guard for the `session/hydrate` RPC result (server PR #791). The
 * `messages` and `replayed_envelopes` fields are both optional — the
 * server omits them when not requested or not negotiated. Treat any
 * non-object payload as a hard reject (returns null), but accept the
 * shape with all-optional sections for back-compat with older servers.
 *
 * Inner-row failure is non-fatal: malformed `messages[i]` / envelope
 * entries are dropped so a single corrupt row doesn't poison the whole
 * hydrate. Cursor is required in the typed wire shape but the SPA
 * doesn't drive off it today, so an absent / malformed cursor falls
 * back to a synthesized zero-cursor rather than rejecting the result.
 */
export function guardSessionHydrate(p: unknown): SessionHydrateResult | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id)) return null;

  let cursor: { stream: string; seq: number };
  if (
    isPlainObject(p.cursor) &&
    typeof p.cursor.stream === "string" &&
    typeof p.cursor.seq === "number" &&
    Number.isFinite(p.cursor.seq) &&
    p.cursor.seq >= 0
  ) {
    cursor = { stream: p.cursor.stream, seq: p.cursor.seq };
  } else {
    cursor = { stream: "", seq: 0 };
  }

  let messages: HydratedMessage[] | undefined;
  if (Array.isArray(p.messages)) {
    messages = [];
    for (const m of p.messages) {
      const guarded = guardHydratedMessage(m);
      if (guarded) messages.push(guarded);
    }
  }

  let replayedEnvelopes: TurnSpawnCompleteEvent[] | undefined;
  if (Array.isArray(p.replayed_envelopes)) {
    replayedEnvelopes = [];
    for (const e of p.replayed_envelopes) {
      const guarded = guardSpawnComplete(e);
      if (guarded) replayedEnvelopes.push(guarded);
    }
  }

  return {
    session_id: p.session_id,
    cursor,
    messages,
    replayed_envelopes: replayedEnvelopes,
  };
}

function guardTaskUpdated(p: unknown): TaskUpdatedEvent | null {
  if (!isPlainObject(p)) return null;
  // The server's `TaskUpdatedEvent` struct does NOT include `turn_id`
  // (supervisor publishes by `task_id` directly). Pre-fix this guard
  // required `turn_id`, which silently dropped EVERY production
  // `task/updated` envelope — TaskStore stayed empty, the
  // task_id→tool_call_id mapping never landed, and `resolveToolCallIdForTask`
  // always fell back to the raw supervisor UUID. The chip then never
  // flipped. Drop the `turn_id` requirement; pick it up if present for
  // forward compatibility. Pick up the new `tool_call_id` field which
  // the parallel server PR adds so the chip status can flip directly
  // from the wire.
  if (!isString(p.session_id) || !isString(p.task_id)) {
    return null;
  }
  if (typeof p.state !== "string") return null;
  return {
    session_id: p.session_id,
    turn_id: isString(p.turn_id) ? p.turn_id : undefined,
    task_id: p.task_id,
    tool_call_id: isString(p.tool_call_id) ? p.tool_call_id : undefined,
    state: p.state,
    title: typeof p.title === "string" ? p.title : undefined,
    runtime_detail:
      typeof p.runtime_detail === "string" ? p.runtime_detail : undefined,
    output_tail:
      typeof p.output_tail === "string" ? p.output_tail : undefined,
  };
}

function guardTaskOutputDelta(p: unknown): TaskOutputDeltaEvent | null {
  if (!isPlainObject(p)) return null;
  // Same relaxation as `guardTaskUpdated`: server-side struct has no
  // `turn_id` field for output deltas either, so this guard previously
  // dropped every production envelope. Keep the field optional and pick
  // up the new wire-borne `tool_call_id`.
  if (!isString(p.session_id) || !isString(p.task_id)) {
    return null;
  }
  if (typeof p.chunk !== "string") return null;
  let cursor: { offset: number } | undefined;
  if (isPlainObject(p.cursor) && typeof p.cursor.offset === "number") {
    cursor = { offset: p.cursor.offset };
  }
  return {
    session_id: p.session_id,
    turn_id: isString(p.turn_id) ? p.turn_id : undefined,
    task_id: p.task_id,
    tool_call_id: isString(p.tool_call_id) ? p.tool_call_id : undefined,
    chunk: p.chunk,
    cursor,
  };
}

function guardTurnStarted(p: unknown): TurnStartedEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id) || !isString(p.turn_id)) return null;
  return { session_id: p.session_id, turn_id: p.turn_id };
}

function guardTurnCompleted(p: unknown): TurnCompletedEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id) || !isString(p.turn_id)) return null;
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    reason: typeof p.reason === "string" ? p.reason : undefined,
  };
}

function guardTurnError(p: unknown): TurnErrorEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id) || !isString(p.turn_id)) return null;
  if (!isPlainObject(p.error)) return null;
  const err = p.error;
  if (typeof err.code !== "number" || typeof err.message !== "string") {
    return null;
  }
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    error: { code: err.code, message: err.message, data: err.data },
  };
}

function guardApprovalRequested(p: unknown): ApprovalRequestedEvent | null {
  if (!isPlainObject(p)) return null;
  if (
    !isString(p.session_id) ||
    !isString(p.approval_id) ||
    !isString(p.turn_id) ||
    !isString(p.tool_name) ||
    typeof p.title !== "string" ||
    typeof p.body !== "string"
  ) {
    return null;
  }
  const scope = p.approval_scope;
  const approval_scope: ApprovalScope | undefined =
    scope === "request" || scope === "turn" || scope === "session"
      ? scope
      : undefined;
  return {
    session_id: p.session_id,
    approval_id: p.approval_id,
    turn_id: p.turn_id,
    tool_name: p.tool_name,
    title: p.title,
    body: p.body,
    approval_kind:
      typeof p.approval_kind === "string" ? p.approval_kind : undefined,
    approval_scope,
    risk: typeof p.risk === "string" ? p.risk : undefined,
    typed_details: isPlainObject(p.typed_details)
      ? (p.typed_details as ApprovalRequestedEvent["typed_details"])
      : undefined,
    render_hints: isPlainObject(p.render_hints)
      ? (p.render_hints as ApprovalRequestedEvent["render_hints"])
      : undefined,
  };
}

function guardWarning(p: unknown): WarningEvent | null {
  if (!isPlainObject(p)) return null;
  if (typeof p.reason !== "string") return null;
  return { reason: p.reason, context: p.context };
}

function guardToolStarted(p: unknown): ToolStartedEvent | null {
  if (!isPlainObject(p)) return null;
  if (
    !isString(p.session_id) ||
    !isString(p.turn_id) ||
    !isString(p.tool_call_id) ||
    !isString(p.tool_name)
  ) {
    return null;
  }
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    tool_call_id: p.tool_call_id,
    tool_name: p.tool_name,
    arguments: p.arguments,
  };
}

function guardToolProgress(p: unknown): ToolProgressEvent | null {
  if (!isPlainObject(p)) return null;
  if (
    !isString(p.session_id) ||
    !isString(p.turn_id) ||
    !isString(p.tool_call_id)
  ) {
    return null;
  }
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    tool_call_id: p.tool_call_id,
    message: typeof p.message === "string" ? p.message : undefined,
    progress_pct:
      typeof p.progress_pct === "number" && Number.isFinite(p.progress_pct)
        ? p.progress_pct
        : undefined,
  };
}

function guardToolCompleted(p: unknown): ToolCompletedEvent | null {
  if (!isPlainObject(p)) return null;
  if (
    !isString(p.session_id) ||
    !isString(p.turn_id) ||
    !isString(p.tool_call_id) ||
    !isString(p.tool_name)
  ) {
    return null;
  }
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    tool_call_id: p.tool_call_id,
    tool_name: p.tool_name,
    success: typeof p.success === "boolean" ? p.success : undefined,
    output_preview:
      typeof p.output_preview === "string" ? p.output_preview : undefined,
    duration_ms:
      typeof p.duration_ms === "number" && Number.isFinite(p.duration_ms)
        ? p.duration_ms
        : undefined,
  };
}

function guardUiTokenCost(p: unknown): UiTokenCostUpdate | undefined {
  if (!isPlainObject(p)) return undefined;
  const out: UiTokenCostUpdate = {};
  if (typeof p.input_tokens === "number") out.input_tokens = p.input_tokens;
  if (typeof p.output_tokens === "number") out.output_tokens = p.output_tokens;
  if (typeof p.reasoning_tokens === "number")
    out.reasoning_tokens = p.reasoning_tokens;
  if (typeof p.cache_read_tokens === "number")
    out.cache_read_tokens = p.cache_read_tokens;
  if (typeof p.cache_write_tokens === "number")
    out.cache_write_tokens = p.cache_write_tokens;
  if (typeof p.total_tokens === "number") out.total_tokens = p.total_tokens;
  if (typeof p.response_cost === "number") out.response_cost = p.response_cost;
  if (typeof p.session_cost === "number") out.session_cost = p.session_cost;
  if (typeof p.currency === "string") out.currency = p.currency;
  // Server PR `feat/cost-update-carry-model` adds `model: Option<String>`
  // to `UiTokenCostUpdate`, populated from
  // `LlmProvider::provider_metadata_for_index(...).model` so the chat
  // bubble footer (`model · tokens_in / tokens_out · duration`) can
  // render even for failover / routed responses. Codex flagged the
  // omission here — without this branch the field is silently dropped
  // by the fail-closed guard before reaching
  // `handleProgressUpdated`, so the router's `cost.model` lookup
  // always resolves `undefined`.
  if (typeof p.model === "string" && p.model.length > 0) out.model = p.model;
  return out;
}

function guardUiRetryBackoff(p: unknown): UiRetryBackoff | undefined {
  if (!isPlainObject(p)) return undefined;
  const out: UiRetryBackoff = {};
  if (typeof p.attempt === "number") out.attempt = p.attempt;
  if (typeof p.max_attempts === "number") out.max_attempts = p.max_attempts;
  if (typeof p.backoff_ms === "number") out.backoff_ms = p.backoff_ms;
  if (typeof p.reason === "string") out.reason = p.reason;
  if (typeof p.provider === "string") out.provider = p.provider;
  if (typeof p.next_provider === "string") out.next_provider = p.next_provider;
  return out;
}

function guardUiFileMutationNotice(
  p: unknown,
): UiFileMutationNotice | undefined {
  if (!isPlainObject(p)) return undefined;
  if (!isString(p.path) || !isString(p.operation)) return undefined;
  const out: UiFileMutationNotice = {
    path: p.path,
    operation: p.operation,
  };
  if (typeof p.tool_call_id === "string") out.tool_call_id = p.tool_call_id;
  if (typeof p.bytes_written === "number") out.bytes_written = p.bytes_written;
  return out;
}

function guardProgressUpdated(p: unknown): ProgressUpdatedEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id)) return null;
  if (!isPlainObject(p.metadata)) return null;
  const m = p.metadata;
  if (!isString(m.kind)) return null;
  const metadata: UiProgressMetadata = {
    kind: m.kind,
  };
  if (typeof m.label === "string") metadata.label = m.label;
  if (typeof m.message === "string") metadata.message = m.message;
  if (typeof m.detail === "string") metadata.detail = m.detail;
  if (typeof m.iteration === "number") metadata.iteration = m.iteration;
  if (typeof m.progress_pct === "number") metadata.progress_pct = m.progress_pct;
  const retry = guardUiRetryBackoff(m.retry);
  if (retry) metadata.retry = retry;
  const fileMutation = guardUiFileMutationNotice(m.file_mutation);
  if (fileMutation) metadata.file_mutation = fileMutation;
  const tokenCost = guardUiTokenCost(m.token_cost);
  if (tokenCost) metadata.token_cost = tokenCost;
  // Pass through any unknown `extra` fields verbatim so a server-side
  // schema extension doesn't trip the fail-closed reject path. Skips the
  // known keys we already lifted above.
  const known = new Set([
    "kind",
    "label",
    "message",
    "detail",
    "iteration",
    "progress_pct",
    "retry",
    "file_mutation",
    "token_cost",
  ]);
  for (const key of Object.keys(m)) {
    if (!known.has(key)) metadata[key] = m[key];
  }
  return {
    session_id: p.session_id,
    turn_id:
      typeof p.turn_id === "string" && p.turn_id.length > 0
        ? p.turn_id
        : undefined,
    metadata,
  };
}

/**
 * Guard for `router/status` (Wave4-A server PR #946). All fields are
 * required on the wire. `lane_scores` / `circuit_breakers` are wire
 * objects (Rust `BTreeMap<String, _>`); we accept any plain object and
 * filter out entries whose value is not the expected primitive type so
 * a future server-side schema extension can't trip the fail-closed
 * reject path.
 */
function guardRouterStatus(p: unknown): RouterStatusEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id)) return null;
  if (!isString(p.provider_name)) return null;
  if (!isString(p.mode)) return null;
  if (typeof p.qos_ranking !== "boolean") return null;
  if (!isPlainObject(p.lane_scores)) return null;
  if (!isPlainObject(p.circuit_breakers)) return null;
  const laneScores: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.lane_scores)) {
    if (typeof v === "number" && Number.isFinite(v)) laneScores[k] = v;
  }
  const breakers: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.circuit_breakers)) {
    if (typeof v === "string") breakers[k] = v;
  }
  return {
    session_id: p.session_id,
    provider_name: p.provider_name,
    mode: p.mode,
    qos_ranking: p.qos_ranking,
    lane_scores: laneScores,
    circuit_breakers: breakers,
  };
}

/**
 * Guard for `router/failover` (Wave4-A server PR #946). All fields are
 * required on the wire. `elapsed_ms` is a `u64` on the wire so we reject
 * negative / non-finite values.
 */
function guardRouterFailover(p: unknown): RouterFailoverEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id)) return null;
  if (!isString(p.from_provider) || !isString(p.to_provider)) return null;
  if (typeof p.reason !== "string") return null;
  if (
    typeof p.elapsed_ms !== "number" ||
    !Number.isFinite(p.elapsed_ms) ||
    p.elapsed_ms < 0
  ) {
    return null;
  }
  return {
    session_id: p.session_id,
    from_provider: p.from_provider,
    to_provider: p.to_provider,
    reason: p.reason,
    elapsed_ms: p.elapsed_ms,
  };
}

/**
 * Guard for `queue/state` (Wave4-A). Client-emitted today (the queue
 * lives in `ui-protocol-send.ts` per-session FIFO); the guard is in
 * place so the bridge round-trips the variant uniformly if the server
 * ever starts emitting it.
 */
function guardQueueState(p: unknown): QueueStateEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id)) return null;
  if (
    typeof p.pending_count !== "number" ||
    !Number.isFinite(p.pending_count) ||
    p.pending_count < 0
  ) {
    return null;
  }
  let head: string | null = null;
  if (typeof p.head_client_message_id === "string" && p.head_client_message_id.length > 0) {
    head = p.head_client_message_id;
  }
  return {
    session_id: p.session_id,
    pending_count: p.pending_count,
    head_client_message_id: head,
  };
}

/** Minimal guard for `session/title-updated`.
 *
 *  The server's ADR-defined payload is
 *  `{ session_id: string, title: string }`. We accept and ignore extra
 *  fields so a server-side payload extension doesn't trip the
 *  fail-closed reject path. Returns the typed event or `null`.
 */
function guardSessionTitleUpdated(
  p: unknown,
): { session_id: string; title: string } | null {
  if (!isPlainObject(p)) return null;
  if (typeof p.session_id !== "string") return null;
  if (typeof p.title !== "string") return null;
  return { session_id: p.session_id, title: p.title };
}

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

class UiProtocolBridgeImpl implements UiProtocolBridge {
  private readonly cfg: Required<
    Pick<
      BridgeConfig,
      | "rpcTimeoutMs"
      | "sendQueueLimit"
      | "maxReconnectAttempts"
      | "keepaliveIntervalMs"
      | "keepaliveTimeoutMs"
    >
  > & {
    origin: string | null;
    getToken: () => string | null;
    getProfileId: () => string | null;
    webSocketImpl: typeof WebSocket;
    generateId: () => string;
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    now: () => number;
    features: readonly string[];
  };

  private state: ConnectionState = "idle";
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private profileId: string | null | undefined = undefined;
  /** Codex BLOCK E: client-side topic scope for envelope filtering.
   *  The server still replays root-scope events to every topic-bridge
   *  today (parallel server PR will add scope-by-topic replay + live).
   *  Until that lands, drop envelopes whose `params.topic` is set and
   *  mismatches — events without `topic` on the wire pass through
   *  because the bridge cannot tell what scope they belong to without
   *  server help. Tracked as a follow-up server issue. */
  private topicScope: string | null = null;
  private stopped = false;
  private reconnectAttempts = 0;
  /** True only after `scheduleReconnect` has exhausted
   *  `maxReconnectAttempts` and given up. Distinguishes the terminal
   *  `state === "error"` case (no recovery possible) from the transient
   *  `onerror` blip that `onWsClose` is about to either schedule a
   *  reconnect for or finalize. The fast-reject in `request()` uses this
   *  to avoid rejecting sends queued during the brief `onerror -> onclose`
   *  window of an otherwise recoverable network hiccup. */
  private reconnectAbandoned = false;
  /** Issue #137 (Yue 2026-05-15): the visibility-driven reset needs to
   *  distinguish *why* the bridge gave up. `"attempts_exhausted"` =
   *  `scheduleReconnect` ran out of attempts after a network outage;
   *  the visibility flip means the user is back and we should retry
   *  once. `"auth_rejected"` = the token was dead (1008 close,
   *  permission_denied on `session/open`, or 401 on the upgrade
   *  fallback); retrying is wasted load until the user re-logs in.
   *  `null` = not abandoned (sentinel for cleared state). */
  private latchReason: "attempts_exhausted" | "auth_rejected" | null = null;
  /** Issue #137: idempotency guard for the visibilitychange handler.
   *  Mobile browsers can fire `visibilitychange` multiple times in
   *  quick succession during app-switches; once we have already
   *  scheduled a visibility-driven reconnect attempt, additional
   *  events must be no-ops until either the attempt finishes (success
   *  resets the flag in `onWsOpen`) or fails (the bounded reconnect
   *  loop takes over and eventually re-latches the abandonment). */
  private visibilityReconnectInFlight = false;
  /** Issue #137: bound visibilitychange listener. Stashed so `stop()`
   *  can remove it; React strict-mode and SPA session-switch flows
   *  call start() → stop() → start() back-to-back. */
  private visibilityListener: (() => void) | null = null;
  private reconnectTimer: unknown = null;
  private keepaliveTimer: unknown = null;
  private lastInboundAt = 0;
  /** True once the bridge has reached `connected` at least once in this
   *  lifecycle. The HTTP-401-at-upgrade fallback uses this to scope the
   *  /api/auth/me probe to the "have never opened" case — a mid-session
   *  reconnect that fails with `onerror+onclose(1006)` after the bridge
   *  was happily live for hours is a transport blip, not an auth-rejected
   *  upgrade. Issue #111.1 (codex BLOCK A): the 1008 hook covers the case
   *  the server WILL emit (parallel server PR); this guard covers what
   *  the server emits TODAY (HTTP 401 at the WS upgrade surfaces as
   *  `onerror` followed by `onclose` with no `onopen`). */
  private hasEverOpened = false;
  /** True once we have dispatched `crew:auth_expired` for this bridge
   *  lifecycle. Prevents spamming AuthProvider with one event per
   *  reconnect attempt during the auth-rejected case. */
  private authExpiredDispatched = false;
  private readonly pending: Map<string, PendingRpc> = new Map();
  private readonly sendQueue: QueuedFrame[] = [];

  private readonly subMessageDelta = new Subscribers<MessageDeltaEvent>();
  private readonly subMessagePersisted = new Subscribers<MessagePersistedEvent>();
  private readonly subSpawnComplete = new Subscribers<TurnSpawnCompleteEvent>();
  private readonly subFileAttached = new Subscribers<FileAttachedEvent>();
  private readonly subTaskUpdated = new Subscribers<TaskUpdatedEvent>();
  private readonly subTaskOutputDelta = new Subscribers<TaskOutputDeltaEvent>();
  private readonly subTurnLifecycle = new Subscribers<
    TurnStartedEvent | TurnCompletedEvent | TurnErrorEvent
  >();
  private readonly subApprovalRequested = new Subscribers<ApprovalRequestedEvent>();
  private readonly subToolStarted = new Subscribers<ToolStartedEvent>();
  private readonly subToolProgress = new Subscribers<ToolProgressEvent>();
  private readonly subToolCompleted = new Subscribers<ToolCompletedEvent>();
  private readonly subProgressUpdated = new Subscribers<ProgressUpdatedEvent>();
  private readonly subRouterStatus = new Subscribers<RouterStatusEvent>();
  private readonly subRouterFailover = new Subscribers<RouterFailoverEvent>();
  private readonly subQueueState = new Subscribers<QueueStateEvent>();
  private readonly subWarning = new Subscribers<WarningEvent>();
  private readonly subState = new Subscribers<ConnectionState>();
  /** Reload-bug fix (Yue 2026-05-15): fires once on every successful
   *  RECONNECT (subsequent `session/open` acks in the same bridge
   *  lifecycle — not the initial open). The runtime layer subscribes
   *  to re-issue `session/hydrate` so envelopes emitted while the WS
   *  was disconnected get replayed from `replayed_envelopes`. */
  private readonly subReopened = new Subscribers<void>();
  private readonly subSessionTitleUpdated = new Subscribers<{
    session_id: string;
    title: string;
  }>();

  private readonly notificationTable: Record<
    string,
    {
      guard: (p: unknown) => unknown | null;
      emit: (v: unknown) => void;
    }
  > = {
    [METHODS.MESSAGE_DELTA]: {
      guard: guardMessageDelta,
      emit: (v) => this.subMessageDelta.emit(v as MessageDeltaEvent),
    },
    [METHODS.MESSAGE_PERSISTED]: {
      guard: guardMessagePersisted,
      emit: (v) => this.subMessagePersisted.emit(v as MessagePersistedEvent),
    },
    [METHODS.TURN_SPAWN_COMPLETE]: {
      guard: guardSpawnComplete,
      emit: (v) => this.subSpawnComplete.emit(v as TurnSpawnCompleteEvent),
    },
    [METHODS.FILE_ATTACHED]: {
      guard: guardFileAttached,
      emit: (v) => this.subFileAttached.emit(v as FileAttachedEvent),
    },
    [METHODS.TASK_UPDATED]: {
      guard: guardTaskUpdated,
      emit: (v) => this.subTaskUpdated.emit(v as TaskUpdatedEvent),
    },
    [METHODS.TASK_OUTPUT_DELTA]: {
      guard: guardTaskOutputDelta,
      emit: (v) => this.subTaskOutputDelta.emit(v as TaskOutputDeltaEvent),
    },
    [METHODS.TURN_STARTED]: {
      guard: guardTurnStarted,
      emit: (v) => this.subTurnLifecycle.emit(v as TurnStartedEvent),
    },
    [METHODS.TURN_COMPLETED]: {
      guard: guardTurnCompleted,
      emit: (v) => this.subTurnLifecycle.emit(v as TurnCompletedEvent),
    },
    [METHODS.TURN_ERROR]: {
      guard: guardTurnError,
      emit: (v) => this.subTurnLifecycle.emit(v as TurnErrorEvent),
    },
    [METHODS.APPROVAL_REQUESTED]: {
      guard: guardApprovalRequested,
      emit: (v) => this.subApprovalRequested.emit(v as ApprovalRequestedEvent),
    },
    [METHODS.TOOL_STARTED]: {
      guard: guardToolStarted,
      emit: (v) => this.subToolStarted.emit(v as ToolStartedEvent),
    },
    [METHODS.TOOL_PROGRESS]: {
      guard: guardToolProgress,
      emit: (v) => this.subToolProgress.emit(v as ToolProgressEvent),
    },
    [METHODS.TOOL_COMPLETED]: {
      guard: guardToolCompleted,
      emit: (v) => this.subToolCompleted.emit(v as ToolCompletedEvent),
    },
    [METHODS.PROGRESS_UPDATED]: {
      guard: guardProgressUpdated,
      emit: (v) => this.subProgressUpdated.emit(v as ProgressUpdatedEvent),
    },
    [METHODS.ROUTER_STATUS]: {
      guard: guardRouterStatus,
      emit: (v) => this.subRouterStatus.emit(v as RouterStatusEvent),
    },
    [METHODS.ROUTER_FAILOVER]: {
      guard: guardRouterFailover,
      emit: (v) => this.subRouterFailover.emit(v as RouterFailoverEvent),
    },
    [METHODS.QUEUE_STATE]: {
      guard: guardQueueState,
      emit: (v) => this.subQueueState.emit(v as QueueStateEvent),
    },
    [METHODS.WARNING]: {
      guard: guardWarning,
      emit: (v) => this.subWarning.emit(v as WarningEvent),
    },
    // Issue #113.2 (was M12 Phase D-3 TODO): the server emits
    // `session/title-updated` after a successful `session/title.set`,
    // so cross-tab and server-side auto-title flows can refresh the
    // sidebar without polling the REST list. SessionProvider subscribes
    // via `onSessionTitleUpdated`; the optimistic update and the
    // notification are idempotent (both write the same title), so the
    // dispatch is safe vs the local rename path.
    [METHODS.SESSION_TITLE_UPDATED]: {
      guard: guardSessionTitleUpdated,
      emit: (v) =>
        this.subSessionTitleUpdated.emit(
          v as { session_id: string; title: string },
        ),
    },
  };

  constructor(config: BridgeConfig | undefined) {
    const cfg = config ?? {};
    this.cfg = {
      origin: cfg.origin ?? null,
      getToken: cfg.getToken ?? getToken,
      getProfileId: cfg.getProfileId ?? (() => getSelectedProfileId()),
      webSocketImpl: cfg.webSocketImpl ?? (globalThis.WebSocket as typeof WebSocket),
      generateId:
        cfg.generateId ??
        (() => {
          if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
          }
          return `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }),
      setTimeout:
        cfg.setTimeout ??
        ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown),
      clearTimeout:
        cfg.clearTimeout ??
        ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)),
      now: cfg.now ?? (() => Date.now()),
      features: cfg.features ?? getUiProtocolFeatures(),
      rpcTimeoutMs: cfg.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
      sendQueueLimit: cfg.sendQueueLimit ?? DEFAULT_SEND_QUEUE_LIMIT,
      maxReconnectAttempts:
        cfg.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      keepaliveIntervalMs: cfg.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS,
      keepaliveTimeoutMs:
        cfg.keepaliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS,
    };
  }

  // ----- public API --------------------------------------------------------

  async start(opts: {
    sessionId: string;
    profileId?: string;
    topic?: string;
  }): Promise<void> {
    if (!opts || !isString(opts.sessionId)) {
      throw new Error("ui-protocol-bridge: start requires sessionId");
    }
    this.stopped = false;
    this.sessionId = opts.sessionId;
    this.profileId = opts.profileId ?? this.cfg.getProfileId();
    // Codex BLOCK E: stash the topic scope for the client-side
    // envelope-mismatch drop. Empty string => no scope (root).
    const t = opts.topic?.trim();
    this.topicScope = t && t.length > 0 ? t : null;
    this.reconnectAttempts = 0;
    this.reconnectAbandoned = false;
    this.latchReason = null;
    this.visibilityReconnectInFlight = false;
    this.hasEverOpened = false;
    this.authExpiredDispatched = false;
    this.installVisibilityListener();
    await this.openSocket();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelReconnectTimer();
    this.cancelKeepalive();
    this.removeVisibilityListener();
    this.setState("closed");
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(NORMAL_CLOSURE, "client_stop");
      } catch {
        // ignore — close errors don't affect the rejection sweep below.
      }
    }
    this.rejectAllPending(new BridgeStoppedError());
    this.sendQueue.length = 0;
    this.subMessageDelta.clear();
    this.subMessagePersisted.clear();
    this.subSpawnComplete.clear();
    this.subFileAttached.clear();
    this.subTaskUpdated.clear();
    this.subTaskOutputDelta.clear();
    this.subTurnLifecycle.clear();
    this.subApprovalRequested.clear();
    this.subToolStarted.clear();
    this.subToolProgress.clear();
    this.subToolCompleted.clear();
    this.subProgressUpdated.clear();
    this.subRouterStatus.clear();
    this.subRouterFailover.clear();
    this.subQueueState.clear();
    this.subWarning.clear();
    this.subState.clear();
    this.subSessionTitleUpdated.clear();
  }

  sendTurn(
    turn_id: string,
    input: TurnStartInput[],
    extras?: TurnStartExtras,
  ): Promise<TurnStartResult> {
    if (!isString(turn_id)) {
      return Promise.reject(new Error("ui-protocol-bridge: sendTurn requires turn_id"));
    }
    // UPCR-2026-015 (M9-β-1): the three optional `media` / `topic` /
    // `rewrite_for` params land on the wire only when populated. The
    // server's serde shape skip-when-empty / skip-when-None on the
    // matching Rust struct, so an old server (or this client without
    // β-1 callers) sees byte-identical bytes to the legacy text-only
    // shape.
    const params: Record<string, unknown> = {
      session_id: this.requireSessionId(),
      turn_id,
      input,
    };
    if (extras?.media && extras.media.length > 0) {
      params.media = extras.media;
    }
    if (extras?.topic && extras.topic.trim().length > 0) {
      params.topic = extras.topic;
    }
    if (extras?.rewrite_for && extras.rewrite_for.length > 0) {
      params.rewrite_for = extras.rewrite_for;
    }
    return this.request<TurnStartResult>(METHODS.TURN_START, params);
  }

  interruptTurn(
    turn_id: string,
    reason?: string,
  ): Promise<TurnInterruptResult> {
    if (!isString(turn_id)) {
      return Promise.reject(
        new Error("ui-protocol-bridge: interruptTurn requires turn_id"),
      );
    }
    const params: Record<string, unknown> = {
      session_id: this.requireSessionId(),
      turn_id,
    };
    if (reason !== undefined) params.reason = reason;
    return this.request<TurnInterruptResult>(METHODS.TURN_INTERRUPT, params);
  }

  respondToApproval(
    approval_id: string,
    decision: ApprovalDecision,
    scope?: ApprovalScope,
    client_note?: string,
  ): Promise<ApprovalRespondResult> {
    if (!isString(approval_id)) {
      return Promise.reject(
        new Error("ui-protocol-bridge: respondToApproval requires approval_id"),
      );
    }
    const params: Record<string, unknown> = {
      session_id: this.requireSessionId(),
      approval_id,
      decision,
    };
    if (scope !== undefined) params.approval_scope = scope;
    if (client_note !== undefined) params.client_note = client_note;
    return this.request<ApprovalRespondResult>(
      METHODS.APPROVAL_RESPOND,
      params,
    );
  }

  async hydrateSession(
    include: ReadonlyArray<
      "messages" | "threads" | "turns" | "pending_approvals"
    > = ["messages"],
  ): Promise<SessionHydrateResult | null> {
    try {
      const raw = await this.request<unknown>(METHODS.SESSION_HYDRATE, {
        session_id: this.requireSessionId(),
        include,
      });
      const guarded = guardSessionHydrate(raw);
      if (!guarded) {
        this.subWarning.emit({
          reason: "hydrate_guard_rejected",
          context: { method: METHODS.SESSION_HYDRATE },
        });
        return null;
      }
      return guarded;
    } catch (err) {
      // Failure is non-fatal — the legacy REST `loadHistory` path still
      // populates the thread store. We just lose the hydrate-time dedup
      // for this session.
      this.subWarning.emit({
        reason: "hydrate_rpc_failed",
        context: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  callMethod<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!isString(method)) {
      return Promise.reject(
        new Error("ui-protocol-bridge: callMethod requires method"),
      );
    }
    return this.request<T>(method, params ?? null);
  }

  onMessageDelta(handler: Listener<MessageDeltaEvent>): () => void {
    return this.subMessageDelta.add(handler);
  }
  onMessagePersisted(handler: Listener<MessagePersistedEvent>): () => void {
    return this.subMessagePersisted.add(handler);
  }
  onSpawnComplete(handler: Listener<TurnSpawnCompleteEvent>): () => void {
    return this.subSpawnComplete.add(handler);
  }
  onFileAttached(handler: Listener<FileAttachedEvent>): () => void {
    return this.subFileAttached.add(handler);
  }
  onTaskUpdated(handler: Listener<TaskUpdatedEvent>): () => void {
    return this.subTaskUpdated.add(handler);
  }
  onTaskOutputDelta(handler: Listener<TaskOutputDeltaEvent>): () => void {
    return this.subTaskOutputDelta.add(handler);
  }
  onTurnLifecycle(
    handler: Listener<TurnStartedEvent | TurnCompletedEvent | TurnErrorEvent>,
  ): () => void {
    return this.subTurnLifecycle.add(handler);
  }
  onApprovalRequested(handler: Listener<ApprovalRequestedEvent>): () => void {
    return this.subApprovalRequested.add(handler);
  }
  onToolStarted(handler: Listener<ToolStartedEvent>): () => void {
    return this.subToolStarted.add(handler);
  }
  onToolProgress(handler: Listener<ToolProgressEvent>): () => void {
    return this.subToolProgress.add(handler);
  }
  onToolCompleted(handler: Listener<ToolCompletedEvent>): () => void {
    return this.subToolCompleted.add(handler);
  }
  onProgressUpdated(handler: Listener<ProgressUpdatedEvent>): () => void {
    return this.subProgressUpdated.add(handler);
  }
  onRouterStatus(handler: Listener<RouterStatusEvent>): () => void {
    return this.subRouterStatus.add(handler);
  }
  onRouterFailover(handler: Listener<RouterFailoverEvent>): () => void {
    return this.subRouterFailover.add(handler);
  }
  onQueueState(handler: Listener<QueueStateEvent>): () => void {
    return this.subQueueState.add(handler);
  }
  onConnectionStateChange(handler: Listener<ConnectionState>): () => void {
    return this.subState.add(handler);
  }
  getConnectionState(): ConnectionState {
    return this.state;
  }
  onReopened(handler: Listener<void>): () => void {
    return this.subReopened.add(handler);
  }
  onWarning(handler: Listener<WarningEvent>): () => void {
    return this.subWarning.add(handler);
  }
  onSessionTitleUpdated(
    handler: Listener<{ session_id: string; title: string }>,
  ): () => void {
    return this.subSessionTitleUpdated.add(handler);
  }

  // ----- internals ---------------------------------------------------------

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error("ui-protocol-bridge: bridge not started");
    }
    return this.sessionId;
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.subState.emit(next);
  }

  private buildUrl(): string {
    const origin =
      this.cfg.origin ??
      (typeof window !== "undefined" && window.location
        ? window.location.origin
        : "");
    const base = origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const params = new URLSearchParams();
    let token = this.cfg.getToken();
    // Last-ditch fallback: read both auth slots directly. Defends against
    // a state race where auth-context hasn't pushed the token through the
    // injected `cfg.getToken` closure yet but localStorage already has it
    // (e.g. fresh OTP login + immediate /chat navigation).
    if (!token && typeof window !== "undefined") {
      try {
        token =
          window.localStorage.getItem(TOKEN_KEY) ||
          window.localStorage.getItem(ADMIN_TOKEN_KEY);
      } catch {
        // localStorage may be unavailable in some sandbox modes — fall through.
      }
    }
    if (!token) {
      // Surface a loud client-side error so users with broken/missing auth
      // see something actionable instead of a silent WS handshake failure.
      // The server rejects unauthenticated WS upgrades, so we'd fail anyway —
      // this just gives the user a useful console signal.
      console.error(
        `[ui-protocol-bridge] No auth token in localStorage ` +
          `(neither ${TOKEN_KEY} nor ${ADMIN_TOKEN_KEY}). ` +
          `WS will fail to connect. Please re-login.`,
      );
    }
    // ?token= falls back into Caddy access logs but is the only path that
    // works in browsers (which forbid setting Authorization on WS).
    if (token) params.append("token", token);
    for (const feature of this.cfg.features) {
      params.append("ui_feature", feature);
    }
    const qs = params.toString();
    return `${base}${UI_PROTOCOL_WS_PATH}${qs ? `?${qs}` : ""}`;
  }

  private async openSocket(): Promise<void> {
    if (this.stopped) return;
    if (!this.cfg.webSocketImpl) {
      throw new Error("ui-protocol-bridge: WebSocket implementation unavailable");
    }
    this.cancelReconnectTimer();
    this.setState("connecting");

    let ws: WebSocket;
    try {
      // Auth flows via `?token=` query param (set by buildUrl). We do NOT
      // pass a Sec-WebSocket-Protocol subprotocol: Chrome aborts the
      // handshake when the client requests one and the server does not
      // echo a chosen protocol in the response, and the axum handler at
      // /api/ui-protocol/ws does not currently negotiate subprotocols.
      ws = new this.cfg.webSocketImpl(this.buildUrl());
    } catch (err) {
      this.setState("error");
      throw err instanceof Error ? err : new Error(String(err));
    }

    this.ws = ws;
    ws.onopen = () => {
      void this.onWsOpen();
    };
    ws.onmessage = (ev) => {
      this.onWsMessage(ev);
    };
    ws.onerror = () => {
      this.onWsError();
    };
    ws.onclose = (ev) => {
      this.onWsClose(ev);
    };
  }

  private async onWsOpen(): Promise<void> {
    if (this.stopped) return;
    this.lastInboundAt = this.cfg.now();
    try {
      const params: Record<string, unknown> = {
        session_id: this.requireSessionId(),
      };
      if (this.profileId) params.profile_id = this.profileId;
      // session/open is the lifecycle gate: state stays at `connecting`
      // until the server acks. Failure here forces a reconnect so the next
      // attempt re-runs the handshake with a fresh socket.
      await this.request<SessionOpenResult>(METHODS.SESSION_OPEN, params, {
        bypassQueue: true,
      });
      if (this.stopped) return;
      this.reconnectAttempts = 0;
      this.reconnectAbandoned = false;
      // Issue #137: a successful (re)open clears the latch reason and
      // releases the visibility-reconnect idempotency flag.
      this.latchReason = null;
      this.visibilityReconnectInFlight = false;
      // Snapshot whether this is a reopen BEFORE flipping `hasEverOpened`,
      // so the emit below only fires after a reconnect (subsequent
      // `session/open` ack) and not on the initial open — the runtime
      // layer hydrates immediately on the initial open via
      // `startBridgeForSession`.
      const isReopen = this.hasEverOpened;
      this.hasEverOpened = true;
      this.setState("connected");
      this.startKeepalive();
      this.flushSendQueue();
      if (isReopen) {
        // Reload-bug fix (Yue 2026-05-15): the server treats a
        // cursorless `session/open` as "live only, no replay"
        // (`ui_protocol_ledger.rs:1199`). Envelopes the server emitted
        // while the WS was disconnected (e.g. a `TurnSpawnComplete`
        // for a long-running `spawn_only`) would be silently dropped
        // without this hook. The runtime layer subscribes here to
        // re-fetch `session/hydrate` so `replayed_envelopes` rolls the
        // ledger forward for the user's missed turn.
        this.subReopened.emit();
      }
    } catch (err) {
      if (this.stopped) return;
      this.subWarning.emit({
        reason: "session_open_failed",
        context: err instanceof Error ? err.message : err,
      });
      // Codex BLOCK A: an RPC `permission_denied` (-32120) on
      // `session/open` means the server accepted the WS upgrade
      // (token was structurally present) but refused the open
      // because the user has no scope on this session — for the
      // chat surface that's auth-equivalent to a dead token, so
      // route through `crew:auth_expired` rather than burning
      // reconnect cycles.
      if (err instanceof BridgeRpcError && err.code === RPC_ERROR_PERMISSION_DENIED) {
        this.dispatchAuthExpired("permission_denied:session/open");
        this.reconnectAbandoned = true;
        // Issue #137: tag as auth-rejected so the visibilitychange-driven
        // reset does NOT retry — the token is dead, retrying is wasted load.
        this.latchReason = "auth_rejected";
        this.setState("error");
        this.rejectAllPending(new BridgeStoppedError("auth permission denied"));
        return;
      }
      this.scheduleReconnect();
    }
  }

  private onWsMessage(ev: MessageEvent): void {
    if (this.stopped) return;
    if (typeof ev.data !== "string") {
      this.subWarning.emit({
        reason: "non_text_frame",
        context: typeof ev.data,
      });
      return;
    }
    this.lastInboundAt = this.cfg.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      this.subWarning.emit({ reason: "json_parse_error" });
      return;
    }
    if (!isPlainObject(parsed)) {
      this.subWarning.emit({ reason: "envelope_not_object" });
      return;
    }
    if (parsed.jsonrpc !== JSON_RPC_VERSION) {
      this.subWarning.emit({
        reason: "envelope_jsonrpc_mismatch",
        context: parsed.jsonrpc,
      });
      return;
    }
    if (typeof parsed.id === "string") {
      this.dispatchResponse(parsed as unknown as JsonRpcResponse);
      return;
    }
    if (typeof parsed.method === "string") {
      this.dispatchNotification(parsed as unknown as JsonRpcNotification);
      return;
    }
    this.subWarning.emit({ reason: "envelope_unrecognized" });
  }

  private dispatchResponse(resp: JsonRpcResponse): void {
    const pending = this.pending.get(resp.id);
    if (!pending) {
      this.subWarning.emit({ reason: "rpc_id_unmatched", context: resp.id });
      return;
    }
    this.pending.delete(resp.id);
    this.cfg.clearTimeout(pending.timer);
    if (resp.error) {
      // Codex BLOCK A: RPC-level `permission_denied` (-32120) on
      // `session/open` or `turn/start` signals the user no longer has
      // scope on this surface. Treat it as auth-expired so AuthProvider
      // probes `/api/auth/me` and (when 401s) drops to /login. We do
      // NOT dispatch on `internal_error` etc — only this typed code.
      if (
        resp.error.code === RPC_ERROR_PERMISSION_DENIED &&
        (pending.method === METHODS.SESSION_OPEN ||
          pending.method === METHODS.TURN_START)
      ) {
        this.dispatchAuthExpired(`permission_denied:${pending.method}`);
      }
      pending.reject(
        new BridgeRpcError(
          resp.error.code,
          resp.error.message,
          resp.error.data,
        ),
      );
      return;
    }
    pending.resolve(resp.result);
  }

  private dispatchNotification(note: JsonRpcNotification): void {
    const params = note.params;
    const handler = this.notificationTable[note.method];
    if (!handler) {
      return;
    }
    // Codex BLOCK E: client-side topic scope defense. If THIS bridge
    // negotiated a topic (`topicScope !== null`) and the envelope
    // carries a different `topic` string, drop the event before the
    // typed guard runs — the server PR that scopes replay/live by
    // topic is separate; until then this filter prevents cross-topic
    // bleed for the envelopes that DO carry `topic` on the wire (e.g.
    // `TurnStartedEvent`). Envelopes without a `topic` field still
    // pass through unfiltered; that's documented as best-effort
    // pending the server-side fix.
    if (this.topicScope !== null && isPlainObject(params)) {
      const envTopic = params.topic;
      if (typeof envTopic === "string" && envTopic !== this.topicScope) {
        return;
      }
    }
    const result = handler.guard(params);
    if (!result) {
      this.subWarning.emit({
        reason: `invalid_event:${note.method}`,
        context: params,
      });
      return;
    }
    handler.emit(result);
  }

  private onWsError(): void {
    if (this.stopped) return;
    // `onerror` always pairs with `onclose`; we just reflect transport state
    // and leave reconnect scheduling to onclose so the timing is consistent.
    this.setState("error");
  }

  private onWsClose(ev: CloseEvent): void {
    this.cancelKeepalive();
    if (this.stopped) return;
    this.ws = null;
    if (ev?.code === NORMAL_CLOSURE) {
      this.setState("closed");
      this.rejectAllPending(new BridgeStoppedError("connection closed"));
      return;
    }
    // Issue #111.1: the server rejects an authenticated WS upgrade
    // with close-code 1008 ("policy violation") when the token is
    // expired/invalid. Pre-fix the bridge silently retried the
    // handshake on every backoff tick — burning auth-rejected
    // handshakes forever and leaving the user stuck on /chat with no
    // path to re-login. Surface a typed `crew:auth_expired` window
    // event so AuthProvider's subscriber can call `revalidate()`,
    // which clears tokens and navigates to /login.
    if (ev?.code === 1008) {
      this.dispatchAuthExpired(ev.reason ?? "policy_violation");
      // Stop reconnect attempts — the token is dead, retrying is
      // wasted load on the server and noise on the client.
      this.reconnectAbandoned = true;
      // Issue #137: auth-rejected latch — the visibility-driven reset
      // must NOT retry here. The visibility listener gates on this.
      this.latchReason = "auth_rejected";
      this.setState("error");
      this.rejectAllPending(new BridgeStoppedError("auth expired"));
      return;
    }
    // Codex BLOCK A: the server today rejects an authenticated WS
    // upgrade with HTTP 401 — the browser surfaces that as
    // `onerror` followed by `onclose(1006, "")` with no `onopen`.
    // Probe `/api/auth/me`: a 401 there closes the loop via api/client's
    // 401 interceptor (which clears tokens and redirects to /login),
    // and the probe also dispatches `crew:auth_expired` so AuthProvider's
    // revalidate path takes effect even when the interceptor lets the
    // 401 through. We only run this when the bridge has NEVER opened
    // in this lifecycle — a mid-session 1006 close after the bridge
    // was happily live is a transport blip, not an auth expiry.
    // The parallel server PR will add the 1008 emit above, after which
    // this fallback can stay as a defense for older servers.
    if (!this.hasEverOpened) {
      void this.probeAuthAndMaybeExpire();
    }
    this.scheduleReconnect();
  }

  /** Dispatch the `crew:auth_expired` window event idempotently per
   *  bridge lifecycle. AuthProvider subscribes and runs `revalidate()`,
   *  which probes `/api/auth/me` and (on 401) clears tokens + redirects. */
  private dispatchAuthExpired(reason: string): void {
    if (this.authExpiredDispatched) return;
    this.authExpiredDispatched = true;
    if (typeof window === "undefined") return;
    try {
      window.dispatchEvent(
        new CustomEvent("crew:auth_expired", { detail: { reason } }),
      );
    } catch {
      // CustomEvent / dispatchEvent unavailable in the sandbox — best-effort.
    }
  }

  /** Codex BLOCK A: probe `/api/auth/me` after a never-opened WS close.
   *  Treat any 401 there as auth-expired. Best-effort — failures here
   *  (network down, /api/auth/me 500s) don't dispatch the event so
   *  legitimate transport blips before the first connect don't surface
   *  a spurious re-login prompt. The actual 401 path is also driven by
   *  api/client's existing 401 interceptor (clears tokens, redirects);
   *  the explicit dispatch covers the gap when the probe runs ahead
   *  of any other authenticated REST call. */
  private async probeAuthAndMaybeExpire(): Promise<void> {
    if (typeof fetch !== "function") return;
    try {
      const resp = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (resp.status === 401) {
        this.dispatchAuthExpired("upgrade_401");
        this.reconnectAbandoned = true;
        // Issue #137: probe-driven auth-rejected latch.
        this.latchReason = "auth_rejected";
      }
    } catch {
      // Network probe failed — leave reconnect scheduling alone.
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectAttempts >= this.cfg.maxReconnectAttempts) {
      this.reconnectAbandoned = true;
      // Issue #137: attempt-exhaustion latch. Distinct from the
      // auth-rejected latch sites above — the visibilitychange
      // handler ONLY retries when the latch is for this reason.
      this.latchReason = "attempts_exhausted";
      this.setState("error");
      this.rejectAllPending(new BridgeStoppedError("max reconnect attempts"));
      return;
    }
    this.setState("reconnecting");
    const delay =
      RECONNECT_BACKOFF_MS[this.reconnectAttempts] ?? RECONNECT_BACKOFF_CAP_MS;
    this.reconnectAttempts += 1;
    this.cancelReconnectTimer();
    this.reconnectTimer = this.cfg.setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      this.cfg.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Issue #137 (Yue 2026-05-15): visibility-driven reset of
   * `reconnectAbandoned`.
   *
   * PR #136 wired `onReopened` → `session/hydrate(["messages"])` so
   * reconnects WITHIN the bounded loop's 121s envelope now replay missed
   * envelopes correctly. But after the 8 attempts elapse,
   * `reconnectAbandoned=true` latches and live state is stranded until
   * the user manually refreshes — exactly the lid-open / phone-unlock /
   * long-network-drop scenario the user reported.
   *
   * The fix is conservative: we only revive the bridge when (1) the
   * user is demonstrably back at the tab (`visibilityState='visible'`),
   * (2) the bridge has *given up* (`reconnectAbandoned=true`), and (3)
   * the reason for giving up was *attempt exhaustion* (NOT an
   * auth-rejected latch — the token is still dead in that case, so
   * retrying just spams the server). We also require (4) we have
   * actually connected once in this bridge lifecycle (`hasEverOpened`),
   * because the visibility flip during the initial-connection phase is
   * the user simply switching to the tab as the page loads — the
   * regular reconnect loop is still in flight and should not be
   * shoved aside.
   *
   * On the trigger we clear the latch + reset the attempt counter +
   * call `openSocket()`. That routes through the same code path the
   * bounded loop uses, so `onWsOpen` will see `hasEverOpened=true` and
   * fire `subReopened`, which the runtime layer subscribes to in order
   * to re-issue `session/hydrate` and recover the missed envelopes.
   *
   * SSR / non-browser env: `document` may be undefined (e.g. Node
   * worker, vitest's default environment is jsdom but consumers may
   * inject the bridge in a server-side context); guard accordingly.
   */
  private installVisibilityListener(): void {
    if (typeof document === "undefined") return;
    if (this.visibilityListener) return; // already installed
    const handler = () => {
      this.onVisibilityChange();
    };
    this.visibilityListener = handler;
    try {
      document.addEventListener("visibilitychange", handler);
    } catch {
      // Defensive: some sandbox envs may forbid event listeners.
      this.visibilityListener = null;
    }
  }

  private removeVisibilityListener(): void {
    if (typeof document === "undefined") return;
    const handler = this.visibilityListener;
    if (!handler) return;
    this.visibilityListener = null;
    try {
      document.removeEventListener("visibilitychange", handler);
    } catch {
      // best-effort
    }
  }

  private onVisibilityChange(): void {
    if (this.stopped) return;
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;
    // Gate: only fire when the bridge has *given up* via attempt
    // exhaustion. An auth-rejected latch (`"auth_rejected"`) means the
    // token is dead — retrying is wasted load until the user
    // re-authenticates; AuthProvider's `crew:auth_expired` subscriber
    // has already kicked off that flow.
    if (!this.reconnectAbandoned) return;
    if (this.latchReason !== "attempts_exhausted") return;
    // Skip the trigger during the bridge's initial-connection phase.
    // If we have never reached `connected` in this lifecycle, the
    // regular reconnect loop is still working on it (or the bridge is
    // mid-`openSocket()`); the user can wait for the regular path.
    if (!this.hasEverOpened) return;
    // Idempotency: mobile browsers fire `visibilitychange` repeatedly
    // during app-switches. Once we have started a reconnect attempt
    // from this trigger and it's still in flight, swallow further
    // visible events until either `onWsOpen` resets the flag or the
    // bounded reconnect loop re-latches the abandonment.
    if (this.visibilityReconnectInFlight) return;
    this.visibilityReconnectInFlight = true;

    // Clear the latch + reset the attempt counter. The reset is
    // important: pre-fix, `reconnectAttempts` was at
    // `maxReconnectAttempts` after the bounded loop gave up, so even
    // if we cleared `reconnectAbandoned` without resetting the
    // counter, the very next `scheduleReconnect` call (e.g. from an
    // `onWsClose` after this new socket fails to open) would
    // immediately re-latch.
    this.reconnectAbandoned = false;
    this.latchReason = null;
    this.reconnectAttempts = 0;
    // Start ONE reconnect attempt through the existing flow so
    // `onWsOpen` fires `subReopened` (the hydrate hook) on success.
    void this.openSocket();
  }

  private startKeepalive(): void {
    this.cancelKeepalive();
    this.lastInboundAt = this.cfg.now();
    const tick = () => {
      if (this.stopped || this.state !== "connected") return;
      const now = this.cfg.now();
      const silence = now - this.lastInboundAt;
      if (silence >= this.cfg.keepaliveTimeoutMs) {
        const ws = this.ws;
        this.ws = null;
        try {
          ws?.close(4000, "keepalive_timeout");
        } catch {
          // ignore
        }
        this.scheduleReconnect();
        return;
      }
      this.sendNotification(METHODS.PING, { ts: now });
      this.keepaliveTimer = this.cfg.setTimeout(tick, this.cfg.keepaliveIntervalMs);
    };
    this.keepaliveTimer = this.cfg.setTimeout(
      tick,
      this.cfg.keepaliveIntervalMs,
    );
  }

  private cancelKeepalive(): void {
    if (this.keepaliveTimer != null) {
      this.cfg.clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      this.cfg.clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private request<T>(
    method: string,
    params: unknown,
    opts?: { bypassQueue?: boolean; timeoutMs?: number },
  ): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new BridgeStoppedError());
    }
    // Fast-reject when the bridge is permanently dead so callers
    // (`sendTurn`/`interruptTurn`/`respondToApproval`) don't silently
    // park frames in `sendQueue` whose Promise never settles — that
    // hang is what makes the user's optimistic bubble vanish upstream
    // when their network drops mid-session.
    //
    // We only treat two situations as terminal:
    //   - `state === "closed"`: NORMAL_CLOSURE arrived (or `stop()` ran);
    //     the socket will not reopen on its own.
    //   - `state === "error"` AND `reconnectAbandoned`: scheduleReconnect
    //     hit `maxReconnectAttempts` and gave up.
    //
    // A bare `state === "error"` without `reconnectAbandoned` is the
    // browser-event blip between `onerror` and `onclose` for a network
    // hiccup that's about to schedule a reconnect — those sends should
    // queue, not reject (codex M10.5 Wave A round-4 follow-up).
    //
    // `bypassQueue` callers (the handshake `session/open` during
    // `onopen`) handle their own socket-not-open path below, so we only
    // gate the normal request path here.
    if (
      !opts?.bypassQueue &&
      (this.state === "closed" ||
        (this.state === "error" && this.reconnectAbandoned))
    ) {
      return Promise.reject(
        new BridgeStoppedError(
          "WebSocket connection is closed; please refresh the page",
        ),
      );
    }
    const id = this.cfg.generateId();
    const frame: JsonRpcRequest = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method,
      params,
    };
    const text = JSON.stringify(frame);
    const timeoutMs = opts?.timeoutMs ?? this.cfg.rpcTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = this.cfg.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // Issue #109.2: drop the matching queued frame so a late
        // reconnect-flush does not re-send a request whose Promise we
        // just rejected with `BridgeTimeoutError`. Pre-fix, the
        // `pending[id]` entry was deleted but the raw frame in
        // `sendQueue` survived — after reconnect, the frame fired,
        // the server processed it, but the client had no pending
        // resolver. Worst case: a duplicate `turn/start` materialised
        // on the server seconds after the user's UI gave up.
        this.dropQueuedRpc(id);
        reject(new BridgeTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      if (opts?.bypassQueue) {
        // session/open during onopen needs to bypass the queue — at that
        // moment state is still `connecting` so the queue path would defer
        // it forever, blocking the handshake completion.
        const sent = this.rawSend(text);
        if (!sent) {
          this.pending.delete(id);
          this.cfg.clearTimeout(timer);
          reject(new BridgeStoppedError("socket not open for handshake"));
        }
        return;
      }

      if (this.state === "connected") {
        if (!this.rawSend(text)) {
          this.enqueueFrame({ text, rpcId: id });
        }
        return;
      }
      this.enqueueFrame({ text, rpcId: id });
    });
  }

  private sendNotification(method: string, params: unknown): void {
    // Drop notifications outright when the bridge is permanently dead
    // (cf. fast-reject in `request`); queueing them on a socket that
    // will never reopen just leaks memory. Only treat the terminal
    // post-max-retries `error` as dead — a transient `onerror` between
    // `onerror` and `onclose` is about to reconnect, so we let the
    // notification queue and flush after handshake.
    if (
      this.state === "closed" ||
      (this.state === "error" && this.reconnectAbandoned)
    ) {
      return;
    }
    const frame: JsonRpcNotification = {
      jsonrpc: JSON_RPC_VERSION,
      method,
      params,
    };
    const text = JSON.stringify(frame);
    if (this.state === "connected") {
      if (!this.rawSend(text)) this.enqueueFrame({ text });
      return;
    }
    this.enqueueFrame({ text });
  }

  private rawSend(text: string): boolean {
    const ws = this.ws;
    if (!ws) return false;
    if (ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  private enqueueFrame(frame: QueuedFrame): void {
    if (this.sendQueue.length >= this.cfg.sendQueueLimit) {
      const dropped = this.sendQueue.shift();
      this.subWarning.emit({
        reason: "send_queue_overflow",
        context: { dropped_bytes: dropped?.text.length ?? 0 },
      });
    }
    this.sendQueue.push(frame);
  }

  /**
   * Issue #109.2: drop a queued frame by its RPC id. Called when the
   * RPC's timeout fires before the frame leaves the queue, so a
   * later reconnect-flush does not re-send a request whose Promise
   * we have already rejected.
   */
  private dropQueuedRpc(rpcId: string): void {
    const idx = this.sendQueue.findIndex((f) => f.rpcId === rpcId);
    if (idx >= 0) {
      this.sendQueue.splice(idx, 1);
    }
  }

  private flushSendQueue(): void {
    while (this.state === "connected" && this.sendQueue.length > 0) {
      const next = this.sendQueue[0];
      if (!this.rawSend(next.text)) return;
      this.sendQueue.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUiProtocolBridge(
  config?: BridgeConfig,
): UiProtocolBridge {
  return new UiProtocolBridgeImpl(config);
}

// Test-only export so the unit tests can drive guard logic directly without
// rebuilding the WS scaffolding for every shape variation.
export const __INTERNAL_GUARDS_FOR_TEST__ = {
  guardMessageDelta,
  guardMessagePersisted,
  guardSpawnComplete,
  guardSessionHydrate,
  guardTaskUpdated,
  guardTaskOutputDelta,
  guardTurnStarted,
  guardTurnCompleted,
  guardTurnError,
  guardApprovalRequested,
  guardToolStarted,
  guardToolProgress,
  guardToolCompleted,
  guardProgressUpdated,
  guardRouterStatus,
  guardRouterFailover,
  guardQueueState,
  guardWarning,
};
