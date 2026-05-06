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
import type {
  ApprovalDecision,
  ApprovalRequestedEvent,
  ApprovalRespondResult,
  ApprovalScope,
  ConnectionState,
  HydratedMessage,
  MessageDeltaEvent,
  MessagePersistedEvent,
  RpcErrorPayload,
  SessionHydrateResult,
  SessionOpenResult,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnInterruptResult,
  TurnSpawnCompleteEvent,
  TurnStartInput,
  TurnStartResult,
  TurnStartedEvent,
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
  SessionHydrateResult,
  SessionOpenResult,
  SessionOpenedResult,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnInterruptResult,
  TurnSpawnCompleteEvent,
  TurnStartInput,
  TurnStartResult,
  TurnStartedEvent,
  UiCursor,
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
  // server → client
  MESSAGE_DELTA: "message/delta",
  MESSAGE_PERSISTED: "message/persisted",
  TASK_UPDATED: "task/updated",
  TASK_OUTPUT_DELTA: "task/output/delta",
  TURN_STARTED: "turn/started",
  TURN_COMPLETED: "turn/completed",
  TURN_ERROR: "turn/error",
  TURN_SPAWN_COMPLETE: "turn/spawn_complete",
  APPROVAL_REQUESTED: "approval/requested",
  WARNING: "warning",
} as const;

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
  // M10 Phase 6.2 (server PR #791 / Bug C): server gates `session/hydrate`
  // RPC behind this feature when feature negotiation is present (UPCR-2026-009).
  // Without it, our hydrate dedup pass never runs because the server
  // returns `method_not_supported` for the RPC. The dedup snapshot
  // populated post-`session/open` from the negotiated `replayed_envelopes`
  // is what eliminates the N+1 bubble render after page reload.
  "state.session_hydrate.v1",
] as const;

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
  start(opts: { sessionId: string; profileId?: string }): Promise<void>;
  stop(): Promise<void>;

  sendTurn(turn_id: string, input: TurnStartInput[]): Promise<TurnStartResult>;
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

  onMessageDelta(handler: (e: MessageDeltaEvent) => void): () => void;
  onMessagePersisted(handler: (e: MessagePersistedEvent) => void): () => void;
  onSpawnComplete(handler: (e: TurnSpawnCompleteEvent) => void): () => void;
  onTaskUpdated(handler: (e: TaskUpdatedEvent) => void): () => void;
  onTaskOutputDelta(handler: (e: TaskOutputDeltaEvent) => void): () => void;
  onTurnLifecycle(
    handler: (
      e: TurnStartedEvent | TurnCompletedEvent | TurnErrorEvent,
    ) => void,
  ): () => void;
  onApprovalRequested(handler: (e: ApprovalRequestedEvent) => void): () => void;
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void;
  onWarning(handler: (e: WarningEvent) => void): () => void;
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

type QueuedFrame = string;

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: unknown;
}

type Listener<T> = (value: T) => void;

// Bug B diagnostic instrumentation. Gated on
// `localStorage.octos_debug_envelope === '1'`. NEVER logs in production
// by default; toggled on per test run only. See M10 follow-up Bug B —
// the goal is to capture every `turn/spawn_complete` envelope the bridge
// SEES so we can diff against what ThreadStore actually appends. Cheap
// no-op when the flag is off (single localStorage read on each call).
function debugEnvelopeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("octos_debug_envelope") === "1";
  } catch {
    return false;
  }
}

export function debugEnvelopeLog(tag: string, payload: unknown): void {
  if (!debugEnvelopeEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(`[bug-b] ${tag}`, payload);
}

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
  if (!isString(p.session_id) || !isString(p.turn_id) || !isString(p.task_id)) {
    return null;
  }
  if (typeof p.state !== "string") return null;
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    task_id: p.task_id,
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
  if (!isString(p.session_id) || !isString(p.turn_id) || !isString(p.task_id)) {
    return null;
  }
  if (typeof p.chunk !== "string") return null;
  let cursor: { offset: number } | undefined;
  if (isPlainObject(p.cursor) && typeof p.cursor.offset === "number") {
    cursor = { offset: p.cursor.offset };
  }
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    task_id: p.task_id,
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
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: unknown = null;
  private keepaliveTimer: unknown = null;
  private lastInboundAt = 0;
  private readonly pending: Map<string, PendingRpc> = new Map();
  private readonly sendQueue: QueuedFrame[] = [];

  private readonly subMessageDelta = new Subscribers<MessageDeltaEvent>();
  private readonly subMessagePersisted = new Subscribers<MessagePersistedEvent>();
  private readonly subSpawnComplete = new Subscribers<TurnSpawnCompleteEvent>();
  private readonly subTaskUpdated = new Subscribers<TaskUpdatedEvent>();
  private readonly subTaskOutputDelta = new Subscribers<TaskOutputDeltaEvent>();
  private readonly subTurnLifecycle = new Subscribers<
    TurnStartedEvent | TurnCompletedEvent | TurnErrorEvent
  >();
  private readonly subApprovalRequested = new Subscribers<ApprovalRequestedEvent>();
  private readonly subWarning = new Subscribers<WarningEvent>();
  private readonly subState = new Subscribers<ConnectionState>();

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
    [METHODS.WARNING]: {
      guard: guardWarning,
      emit: (v) => this.subWarning.emit(v as WarningEvent),
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
      features: cfg.features ?? UI_PROTOCOL_FEATURES,
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

  async start(opts: { sessionId: string; profileId?: string }): Promise<void> {
    if (!opts || !isString(opts.sessionId)) {
      throw new Error("ui-protocol-bridge: start requires sessionId");
    }
    this.stopped = false;
    this.sessionId = opts.sessionId;
    this.profileId = opts.profileId ?? this.cfg.getProfileId();
    this.reconnectAttempts = 0;
    await this.openSocket();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelReconnectTimer();
    this.cancelKeepalive();
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
    this.subTaskUpdated.clear();
    this.subTaskOutputDelta.clear();
    this.subTurnLifecycle.clear();
    this.subApprovalRequested.clear();
    this.subWarning.clear();
    this.subState.clear();
  }

  sendTurn(turn_id: string, input: TurnStartInput[]): Promise<TurnStartResult> {
    if (!isString(turn_id)) {
      return Promise.reject(new Error("ui-protocol-bridge: sendTurn requires turn_id"));
    }
    return this.request<TurnStartResult>(METHODS.TURN_START, {
      session_id: this.requireSessionId(),
      turn_id,
      input,
    });
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

  onMessageDelta(handler: Listener<MessageDeltaEvent>): () => void {
    return this.subMessageDelta.add(handler);
  }
  onMessagePersisted(handler: Listener<MessagePersistedEvent>): () => void {
    return this.subMessagePersisted.add(handler);
  }
  onSpawnComplete(handler: Listener<TurnSpawnCompleteEvent>): () => void {
    return this.subSpawnComplete.add(handler);
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
  onConnectionStateChange(handler: Listener<ConnectionState>): () => void {
    return this.subState.add(handler);
  }
  onWarning(handler: Listener<WarningEvent>): () => void {
    return this.subWarning.add(handler);
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
      this.setState("connected");
      this.startKeepalive();
      this.flushSendQueue();
    } catch (err) {
      if (this.stopped) return;
      this.subWarning.emit({
        reason: "session_open_failed",
        context: err instanceof Error ? err.message : err,
      });
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
      // Bug B diagnostic: surface unhandled methods to the debug log
      // so a server-side rename (or capability negotiation gap) shows
      // up immediately instead of silently dropping events.
      debugEnvelopeLog("notif:unhandled-method", { method: note.method });
      return;
    }
    const result = handler.guard(params);
    if (!result) {
      // Bug B diagnostic: spawn_complete envelopes that fail the guard
      // produce no DOM bubble. Surface the rejected method + raw params
      // so we can spot wire-shape regressions on the failing path.
      debugEnvelopeLog("notif:guard-rejected", {
        method: note.method,
        params,
      });
      this.subWarning.emit({
        reason: `invalid_event:${note.method}`,
        context: params,
      });
      return;
    }
    if (note.method === METHODS.TURN_SPAWN_COMPLETE) {
      const r = result as TurnSpawnCompleteEvent;
      debugEnvelopeLog("notif:spawn_complete", {
        task_id: r.task_id,
        thread_id: r.thread_id,
        turn_id: r.turn_id,
        seq: r.seq,
        message_id: r.message_id,
        content_len: r.content.length,
        media_count: r.media?.length ?? 0,
        rcm: r.response_to_client_message_id,
      });
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
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectAttempts >= this.cfg.maxReconnectAttempts) {
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
          this.enqueueFrame(text);
        }
        return;
      }
      this.enqueueFrame(text);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const frame: JsonRpcNotification = {
      jsonrpc: JSON_RPC_VERSION,
      method,
      params,
    };
    const text = JSON.stringify(frame);
    if (this.state === "connected") {
      if (!this.rawSend(text)) this.enqueueFrame(text);
      return;
    }
    this.enqueueFrame(text);
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

  private enqueueFrame(text: string): void {
    if (this.sendQueue.length >= this.cfg.sendQueueLimit) {
      const dropped = this.sendQueue.shift();
      this.subWarning.emit({
        reason: "send_queue_overflow",
        context: { dropped_bytes: dropped?.length ?? 0 },
      });
    }
    this.sendQueue.push(text);
  }

  private flushSendQueue(): void {
    while (this.state === "connected" && this.sendQueue.length > 0) {
      const next = this.sendQueue[0];
      if (!this.rawSend(next)) return;
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
  guardWarning,
};
