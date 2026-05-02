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
import type {
  ApprovalDecision,
  ApprovalRequestedEvent,
  ApprovalRespondResult,
  ApprovalScope,
  ConnectionState,
  MessageDeltaEvent,
  MessagePersistedEvent,
  RpcErrorPayload,
  SessionOpenResult,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnInterruptResult,
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
  MessageDeltaEvent,
  MessagePersistedEvent,
  PersistedMessage,
  PersistedMessageFile,
  SessionOpenResult,
  SessionOpenedResult,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnInterruptResult,
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
  APPROVAL_REQUESTED: "approval/requested",
  WARNING: "warning",
} as const;

export const UI_PROTOCOL_FEATURES = [
  "approval.typed.v1",
  "pane.snapshots.v1",
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

  onMessageDelta(handler: (e: MessageDeltaEvent) => void): () => void;
  onMessagePersisted(handler: (e: MessagePersistedEvent) => void): () => void;
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
  if (typeof p.delta !== "string") return null;
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    delta: p.delta,
    message_id: typeof p.message_id === "string" ? p.message_id : undefined,
  };
}

function guardMessagePersisted(p: unknown): MessagePersistedEvent | null {
  if (!isPlainObject(p)) return null;
  if (!isString(p.session_id) || !isString(p.turn_id)) return null;
  if (!isPlainObject(p.message)) return null;
  const m = p.message;
  if (!isString(m.id) || !isString(m.thread_id)) return null;
  if (typeof m.content !== "string") return null;
  if (m.role !== "assistant" && m.role !== "user" && m.role !== "tool") {
    return null;
  }
  return {
    session_id: p.session_id,
    turn_id: p.turn_id,
    message: m as unknown as MessagePersistedEvent["message"],
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

  onMessageDelta(handler: Listener<MessageDeltaEvent>): () => void {
    return this.subMessageDelta.add(handler);
  }
  onMessagePersisted(handler: Listener<MessagePersistedEvent>): () => void {
    return this.subMessagePersisted.add(handler);
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
    const token = this.cfg.getToken();
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
      // Some browsers may permit setting the bearer via the WS subprotocol;
      // we offer it AND the ?token= fallback so the server can pick whichever
      // path made it through.
      const token = this.cfg.getToken();
      const protocols = token ? [`octos.bearer.${token}`] : undefined;
      ws = new this.cfg.webSocketImpl(this.buildUrl(), protocols);
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
    if (!handler) return;
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
  guardTaskUpdated,
  guardTaskOutputDelta,
  guardTurnStarted,
  guardTurnCompleted,
  guardTurnError,
  guardApprovalRequested,
  guardWarning,
};
