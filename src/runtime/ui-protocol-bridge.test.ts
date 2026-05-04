/**
 * Unit tests for the UI Protocol v1 client bridge (Phase C-1).
 *
 * Covers:
 *   - lifecycle transitions: connecting → connected → closed
 *   - re-startable after stop
 *   - reconnect with exponential backoff under fake timers
 *   - send queue: buffer while not-connected, drain on connected, oldest-drop overflow
 *   - fail-closed type guards: malformed event drops + warning
 *   - notification dispatch routes to typed handlers
 *   - RPC correlation by id; mismatched id surfaces as warning
 *   - RPC timeout rejects after configured ms
 *   - keepalive ping ticks every 30s while connected
 *   - subscriber unsubscribe removes the handler
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  BridgeRpcError,
  BridgeStoppedError,
  BridgeTimeoutError,
  METHODS,
  __INTERNAL_GUARDS_FOR_TEST__ as guards,
  createUiProtocolBridge,
} from "./ui-protocol-bridge";
import type {
  ApprovalRequestedEvent,
  ConnectionState,
  MessageDeltaEvent,
  MessagePersistedEvent,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnStartedEvent,
  WarningEvent,
} from "./ui-protocol-types";

// ---------------------------------------------------------------------------
// MockWebSocket
//
// vitest's jsdom env doesn't ship a controllable WebSocket. We hand-roll one
// so each test can drive open/message/close events directly and assert what
// frames the bridge sent.
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly protocols?: string | string[];
  readyState = MockWebSocket.CONNECTING;
  CONNECTING = MockWebSocket.CONNECTING;
  OPEN = MockWebSocket.OPEN;
  CLOSING = MockWebSocket.CLOSING;
  CLOSED = MockWebSocket.CLOSED;

  sent: string[] = [];

  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  // --- helpers test cases use ------------------------------------------------

  triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  triggerMessage(payload: unknown): void {
    const data =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }

  triggerNonText(): void {
    this.onmessage?.({ data: new ArrayBuffer(4) });
  }

  triggerClose(code = 1006, reason = "abnormal"): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  // --- WebSocket API --------------------------------------------------------

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error(`mock-ws: send while readyState=${this.readyState}`);
    }
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    // Mirror real-browser behavior: close() triggers onclose synchronously
    // in our test harness (real browsers schedule a microtask).
    this.onclose?.({ code });
  }

  // No-op listener API (the bridge uses on*-style props, not addEventListener).
  addEventListener(): void {}
  removeEventListener(): void {}
}

function lastInstance(): MockWebSocket {
  const w = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!w) throw new Error("test: no MockWebSocket instance yet");
  return w;
}

function findRequest(
  ws: MockWebSocket,
  method: string,
): { id: string; params: unknown } {
  for (const text of ws.sent) {
    const parsed = JSON.parse(text) as {
      id?: string;
      method: string;
      params?: unknown;
    };
    if (parsed.method === method && typeof parsed.id === "string") {
      return { id: parsed.id, params: parsed.params };
    }
  }
  throw new Error(`test: no ${method} request sent. sent=${ws.sent.join("|")}`);
}

function makeBridgeOpts(extra: Record<string, unknown> = {}) {
  let counter = 0;
  return {
    origin: "https://test.local",
    getToken: () => "test-token",
    getProfileId: () => null,
    webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    generateId: () => `rpc-${++counter}`,
    ...extra,
  };
}

beforeEach(() => {
  MockWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// guard tests — cheap, exhaustive
// ---------------------------------------------------------------------------

describe("type guards (fail-closed)", () => {
  it("rejects message/delta without turn_id and produces null", () => {
    expect(
      guards.guardMessageDelta({
        session_id: "s",
        delta: "hi",
      }),
    ).toBeNull();
  });

  it("accepts message/delta with all required string fields", () => {
    const ev = guards.guardMessageDelta({
      session_id: "s",
      turn_id: "t",
      delta: "hi",
    });
    expect(ev).toEqual({
      session_id: "s",
      turn_id: "t",
      delta: "hi",
      message_id: undefined,
    });
  });

  it("rejects message/persisted with no seq (UPCR-2026-012 flat shape)", () => {
    expect(
      guards.guardMessagePersisted({
        session_id: "s",
        role: "assistant",
        message_id: "m",
        source: "assistant",
        cursor: { stream: "s", seq: 1 },
        persisted_at: "2026-05-04T00:00:00Z",
      }),
    ).toBeNull();
  });

  it("rejects message/persisted with unknown role", () => {
    expect(
      guards.guardMessagePersisted({
        session_id: "s",
        seq: 1,
        role: "narrator",
        message_id: "m",
        source: "assistant",
        cursor: { stream: "s", seq: 1 },
        persisted_at: "2026-05-04T00:00:00Z",
      }),
    ).toBeNull();
  });

  it("accepts the flat UPCR-2026-012 shape with thread_id", () => {
    const ev = guards.guardMessagePersisted({
      session_id: "s",
      turn_id: "t",
      thread_id: "th",
      seq: 18,
      role: "assistant",
      message_id: "m",
      source: "assistant",
      cursor: { stream: "s", seq: 18 },
      persisted_at: "2026-05-04T00:00:00Z",
    });
    expect(ev?.thread_id).toBe("th");
    expect(ev?.seq).toBe(18);
    expect(ev?.media).toBeUndefined();
  });

  it("accepts message/persisted with media (P1.3 server PR #767)", () => {
    const ev = guards.guardMessagePersisted({
      session_id: "s",
      turn_id: "t",
      thread_id: "th",
      seq: 19,
      role: "assistant",
      message_id: "m2",
      source: "background",
      cursor: { stream: "s", seq: 19 },
      persisted_at: "2026-05-04T00:00:00Z",
      media: ["research/_report.md"],
    });
    expect(ev?.media).toEqual(["research/_report.md"]);
  });

  it("rejects task/updated without task_id", () => {
    expect(
      guards.guardTaskUpdated({
        session_id: "s",
        turn_id: "t",
        state: "running",
      }),
    ).toBeNull();
  });

  it("rejects task/output/delta without chunk", () => {
    expect(
      guards.guardTaskOutputDelta({
        session_id: "s",
        turn_id: "t",
        task_id: "k",
      }),
    ).toBeNull();
  });

  it("rejects approval/requested missing tool_name", () => {
    expect(
      guards.guardApprovalRequested({
        session_id: "s",
        approval_id: "a",
        turn_id: "t",
        title: "x",
        body: "y",
      }),
    ).toBeNull();
  });

  it("accepts approval/requested with valid scope and drops invalid scope", () => {
    const ok = guards.guardApprovalRequested({
      session_id: "s",
      approval_id: "a",
      turn_id: "t",
      tool_name: "shell",
      title: "x",
      body: "y",
      approval_scope: "turn",
    });
    expect(ok?.approval_scope).toBe("turn");
    const bogus = guards.guardApprovalRequested({
      session_id: "s",
      approval_id: "a",
      turn_id: "t",
      tool_name: "shell",
      title: "x",
      body: "y",
      approval_scope: "forever",
    });
    expect(bogus?.approval_scope).toBeUndefined();
  });

  it("rejects turn/error without an error object", () => {
    expect(
      guards.guardTurnError({ session_id: "s", turn_id: "t" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("connection lifecycle", () => {
  it("transitions connecting → connected on session/open ack", async () => {
    const states: ConnectionState[] = [];
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    bridge.onConnectionStateChange((s) => states.push(s));
    const startPromise = bridge.start({ sessionId: "sess-1" });
    // Give the bridge a tick to construct the socket.
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    // The bridge sent session/open immediately after onopen; reply success.
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await startPromise;
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("includes auth token, profile, and ui_feature query params in the URL", async () => {
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ getProfileId: () => "prof-x" }),
    );
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();
    expect(ws.url.startsWith("wss://test.local/api/ui-protocol/ws?")).toBe(
      true,
    );
    expect(ws.url).toContain("token=test-token");
    expect(ws.url).toContain("ui_feature=approval.typed.v1");
    expect(ws.url).toContain("ui_feature=pane.snapshots.v1");
    // Regression-pin for the P1.3 capability negotiation: server gates
    // both live broadcast and cursor replay of `message/persisted`
    // notifications on this feature, so dropping it would silently
    // disable spawn_only attachment delivery.
    expect(ws.url).toContain("ui_feature=event.message_persisted.v1");
    // Regression-pin: do NOT pass Sec-WebSocket-Protocol. Chrome aborts the
    // handshake when the client requests a subprotocol the server does not
    // echo back, and the axum WS handler does not negotiate subprotocols.
    // Auth flows entirely via the `?token=` query param above.
    expect(ws.protocols).toBeUndefined();
  });

  it("session/open params include profile_id when provided to start()", async () => {
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    void bridge.start({ sessionId: "sess-1", profileId: "prof-y" });
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    expect(open.params).toEqual({
      session_id: "sess-1",
      profile_id: "prof-y",
    });
  });

  it("stop() emits closed, closes the socket, and rejects pending RPCs", async () => {
    vi.useFakeTimers();
    const states: ConnectionState[] = [];
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    bridge.onConnectionStateChange((s) => states.push(s));
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();

    // Pending RPC that should reject on stop().
    const pending = bridge.sendTurn("turn-1", [{ kind: "text", text: "hi" }]);
    let caught: unknown;
    pending.catch((err) => {
      caught = err;
    });

    await bridge.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toContain("closed");
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(caught).toBeInstanceOf(BridgeStoppedError);
  });

  it("supports start → stop → start again", async () => {
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    let ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    let open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    await bridge.stop();

    void bridge.start({ sessionId: "sess-2" });
    await Promise.resolve();
    ws = lastInstance();
    expect(ws.url).toContain("token=test-token");
    ws.triggerOpen();
    await Promise.resolve();
    open = findRequest(ws, METHODS.SESSION_OPEN);
    expect(open.params).toEqual({ session_id: "sess-2" });
  });
});

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

describe("reconnect with exponential backoff", () => {
  it("schedules retries on backoff schedule and re-opens on each tick", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    const states: ConnectionState[] = [];
    bridge.onConnectionStateChange((s) => states.push(s));
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws1 = lastInstance();
    ws1.triggerOpen();
    await Promise.resolve();
    const open1 = findRequest(ws1, METHODS.SESSION_OPEN);
    ws1.triggerMessage({
      jsonrpc: "2.0",
      id: open1.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    expect(states).toContain("connected");

    // Drop the socket abnormally — this should schedule a reconnect.
    ws1.triggerClose(1006, "abnormal");
    expect(states).toContain("reconnecting");
    expect(MockWebSocket.instances).toHaveLength(1);

    // Advance the first backoff tick (1s).
    await vi.advanceTimersByTimeAsync(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Drop again to advance the schedule to 2s.
    const ws2 = lastInstance();
    ws2.triggerClose(1006, "abnormal");
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockWebSocket.instances).toHaveLength(3);

    // 2s is too short for the third schedule (4s) — verify nothing fired.
    const ws3 = lastInstance();
    ws3.triggerClose(1006, "abnormal");
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it("transitions to error after maxReconnectAttempts", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ maxReconnectAttempts: 2 }),
    );
    const states: ConnectionState[] = [];
    bridge.onConnectionStateChange((s) => states.push(s));
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws1 = lastInstance();
    ws1.triggerClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = lastInstance();
    ws2.triggerClose(1006);
    await vi.advanceTimersByTimeAsync(2000);
    const ws3 = lastInstance();
    ws3.triggerClose(1006);
    expect(states).toContain("error");
  });
});

// ---------------------------------------------------------------------------
// Send queue
// ---------------------------------------------------------------------------

describe("send queue", () => {
  it("queues frames while not connected and drains on connected", async () => {
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();

    // Bridge is in `connecting` — issuing a turn now should defer the frame
    // until session/open completes and state flips to `connected`.
    void bridge.sendTurn("turn-1", [{ kind: "text", text: "hello" }]);
    expect(ws.sent.find((f) => f.includes(METHODS.TURN_START))).toBeUndefined();

    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    expect(ws.sent.find((f) => f.includes(METHODS.TURN_START))).toBeDefined();
  });

  it("drops oldest entries when the queue overflows and emits warning", async () => {
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ sendQueueLimit: 2 }),
    );
    const warnings: WarningEvent[] = [];
    bridge.onWarning((w) => warnings.push(w));
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();
    void bridge.sendTurn("turn-A", [{ kind: "text", text: "a" }]);
    void bridge.sendTurn("turn-B", [{ kind: "text", text: "b" }]);
    void bridge.sendTurn("turn-C", [{ kind: "text", text: "c" }]);
    expect(warnings.some((w) => w.reason === "send_queue_overflow")).toBe(true);

    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();

    // Only B and C should have actually been sent — A was the oldest entry
    // and got dropped to make room for C when the queue hit the cap.
    const turnFrames = ws.sent
      .map((f) => JSON.parse(f) as { method: string; params?: { turn_id?: string } })
      .filter((f) => f.method === METHODS.TURN_START)
      .map((f) => f.params?.turn_id);
    expect(turnFrames).toEqual(["turn-B", "turn-C"]);
  });
});

// ---------------------------------------------------------------------------
// Notification dispatch
// ---------------------------------------------------------------------------

describe("notification dispatch", () => {
  async function freshConnected() {
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    return { bridge, ws };
  }

  it("routes message/delta to its handler", async () => {
    const { bridge, ws } = await freshConnected();
    const seen: MessageDeltaEvent[] = [];
    bridge.onMessageDelta((e) => seen.push(e));
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.MESSAGE_DELTA,
      params: { session_id: "sess-1", turn_id: "t1", delta: "hi" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].turn_id).toBe("t1");
  });

  it("emits warning when message/delta is missing turn_id", async () => {
    const { bridge, ws } = await freshConnected();
    const warnings: WarningEvent[] = [];
    const deltas: MessageDeltaEvent[] = [];
    bridge.onWarning((w) => warnings.push(w));
    bridge.onMessageDelta((e) => deltas.push(e));
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.MESSAGE_DELTA,
      params: { session_id: "sess-1", delta: "hi" },
    });
    expect(deltas).toHaveLength(0);
    expect(warnings.some((w) => w.reason === "invalid_event:message/delta")).toBe(
      true,
    );
  });

  it("routes message/persisted, task/updated, task/output/delta", async () => {
    const { bridge, ws } = await freshConnected();
    const persisted: MessagePersistedEvent[] = [];
    const tasks: TaskUpdatedEvent[] = [];
    const outputs: TaskOutputDeltaEvent[] = [];
    bridge.onMessagePersisted((e) => persisted.push(e));
    bridge.onTaskUpdated((e) => tasks.push(e));
    bridge.onTaskOutputDelta((e) => outputs.push(e));

    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.MESSAGE_PERSISTED,
      params: {
        session_id: "sess-1",
        turn_id: "t1",
        thread_id: "th1",
        seq: 18,
        role: "assistant",
        message_id: "m1",
        source: "assistant",
        cursor: { stream: "sess-1", seq: 18 },
        persisted_at: "2026-05-04T00:00:00Z",
      },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.TASK_UPDATED,
      params: {
        session_id: "sess-1",
        turn_id: "t1",
        task_id: "task-A",
        state: "running",
      },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.TASK_OUTPUT_DELTA,
      params: {
        session_id: "sess-1",
        turn_id: "t1",
        task_id: "task-A",
        chunk: "log line",
      },
    });

    expect(persisted).toHaveLength(1);
    expect(persisted[0].thread_id).toBe("th1");
    expect(persisted[0].seq).toBe(18);
    expect(tasks[0].task_id).toBe("task-A");
    expect(outputs[0].chunk).toBe("log line");
  });

  it("routes turn lifecycle and approval/requested", async () => {
    const { bridge, ws } = await freshConnected();
    const lifecycle: Array<
      TurnStartedEvent | TurnCompletedEvent | TurnErrorEvent
    > = [];
    const approvals: ApprovalRequestedEvent[] = [];
    bridge.onTurnLifecycle((e) => lifecycle.push(e));
    bridge.onApprovalRequested((e) => approvals.push(e));
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.TURN_STARTED,
      params: { session_id: "sess-1", turn_id: "t1" },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.TURN_ERROR,
      params: {
        session_id: "sess-1",
        turn_id: "t1",
        error: { code: -32603, message: "boom" },
      },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.APPROVAL_REQUESTED,
      params: {
        session_id: "sess-1",
        approval_id: "ap1",
        turn_id: "t1",
        tool_name: "shell",
        title: "Confirm rm",
        body: "rm -rf /tmp/foo",
      },
    });
    expect(lifecycle).toHaveLength(2);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approval_id).toBe("ap1");
  });

  it("routes warning notifications to onWarning", async () => {
    const { bridge, ws } = await freshConnected();
    const warnings: WarningEvent[] = [];
    bridge.onWarning((w) => warnings.push(w));
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.WARNING,
      params: { reason: "ledger_replay_lossy", context: { dropped: 12 } },
    });
    expect(warnings.find((w) => w.reason === "ledger_replay_lossy")).toBeDefined();
  });

  it("emits warning on unparseable JSON and non-text frame", async () => {
    const { bridge, ws } = await freshConnected();
    const warnings: WarningEvent[] = [];
    bridge.onWarning((w) => warnings.push(w));
    ws.triggerMessage("not-json");
    ws.triggerNonText();
    expect(warnings.some((w) => w.reason === "json_parse_error")).toBe(true);
    expect(warnings.some((w) => w.reason === "non_text_frame")).toBe(true);
  });

  it("returns an unsubscribe function that removes the handler", async () => {
    const { bridge, ws } = await freshConnected();
    const seen: MessageDeltaEvent[] = [];
    const unsub = bridge.onMessageDelta((e) => seen.push(e));
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.MESSAGE_DELTA,
      params: { session_id: "sess-1", turn_id: "t1", delta: "a" },
    });
    unsub();
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.MESSAGE_DELTA,
      params: { session_id: "sess-1", turn_id: "t1", delta: "b" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].delta).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// RPC correlation + timeout
// ---------------------------------------------------------------------------

describe("rpc correlation", () => {
  it("routes the response with matching id to the right pending promise", async () => {
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();

    const promise = bridge.sendTurn("turn-1", [{ kind: "text", text: "hi" }]);
    const turnFrame = findRequest(ws, METHODS.TURN_START);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: turnFrame.id,
      result: { accepted: true },
    });
    await expect(promise).resolves.toEqual({ accepted: true });
  });

  it("rejects with BridgeRpcError on error response", async () => {
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();

    const promise = bridge.sendTurn("turn-1", [{ kind: "text", text: "hi" }]);
    const turnFrame = findRequest(ws, METHODS.TURN_START);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: turnFrame.id,
      error: { code: -32004, message: "method_not_supported" },
    });
    await expect(promise).rejects.toBeInstanceOf(BridgeRpcError);
  });

  it("emits warning when response id matches no pending promise", async () => {
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    const warnings: WarningEvent[] = [];
    bridge.onWarning((w) => warnings.push(w));
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: "bogus-id",
      result: { ok: true },
    });
    expect(warnings.some((w) => w.reason === "rpc_id_unmatched")).toBe(true);
  });

  it("times out pending RPCs after rpcTimeoutMs", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ rpcTimeoutMs: 5000 }),
    );
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();

    const promise = bridge.sendTurn("turn-1", [{ kind: "text", text: "hi" }]);
    let captured: unknown;
    promise.catch((err) => {
      captured = err;
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect(captured).toBeInstanceOf(BridgeTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// Keepalive
// ---------------------------------------------------------------------------

describe("keepalive", () => {
  it("sends a ping every 30s while connected", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({
        keepaliveIntervalMs: 30000,
        keepaliveTimeoutMs: 60000,
      }),
    );
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();

    const pingsBefore = ws.sent.filter((f) => f.includes('"ping"')).length;
    await vi.advanceTimersByTimeAsync(30000);
    const pingsAfter = ws.sent.filter((f) => f.includes('"ping"')).length;
    expect(pingsAfter).toBeGreaterThan(pingsBefore);
  });
});
