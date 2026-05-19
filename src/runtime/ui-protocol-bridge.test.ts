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
  TurnSpawnCompleteEvent,
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
        text: "hi",
      }),
    ).toBeNull();
  });

  it("rejects message/delta whose text-bearing field is the legacy `delta` name (M10 Phase 6.2)", () => {
    // The wire field is `text` (see `octos_core::ui_protocol::MessageDeltaEvent`).
    // A payload that uses `delta:` is not what the server emits; reject it
    // explicitly so a future regression that re-introduces the wrong name
    // fails this guard at parse time instead of silently dropping every
    // spawn-ack and surfacing as an empty timestamp-only bubble.
    expect(
      guards.guardMessageDelta({
        session_id: "s",
        turn_id: "t",
        delta: "hi",
      }),
    ).toBeNull();
  });

  it("accepts message/delta with all required string fields", () => {
    const ev = guards.guardMessageDelta({
      session_id: "s",
      turn_id: "t",
      text: "hi",
    });
    expect(ev).toEqual({
      session_id: "s",
      turn_id: "t",
      text: "hi",
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

  // -------------------------------------------------------------------------
  // M10 Phase 2: turn/spawn_complete envelope guard
  // -------------------------------------------------------------------------

  it("accepts a valid turn/spawn_complete envelope", () => {
    const ev = guards.guardSpawnComplete({
      session_id: "sess-1",
      turn_id: "turn-1",
      thread_id: "cmid-user-1",
      task_id: "task_abc123",
      response_to_client_message_id: "cmid-user-1",
      seq: 42,
      message_id: "msg-spawn-1",
      source: "background",
      cursor: { stream: "sess-1", seq: 42 },
      persisted_at: "2026-05-04T00:00:00Z",
      content: "Research complete: 3 sources reviewed.",
      media: ["research/_report.md"],
    });
    expect(ev).not.toBeNull();
    expect(ev?.task_id).toBe("task_abc123");
    expect(ev?.content).toBe("Research complete: 3 sources reviewed.");
    expect(ev?.media).toEqual(["research/_report.md"]);
    expect(ev?.thread_id).toBe("cmid-user-1");
  });

  it("rejects turn/spawn_complete with missing content (distinguishes from spawn-ack)", () => {
    expect(
      guards.guardSpawnComplete({
        session_id: "sess-1",
        task_id: "t",
        seq: 1,
        message_id: "m",
        source: "background",
        cursor: { stream: "sess-1", seq: 1 },
        persisted_at: "2026-05-04T00:00:00Z",
        // content omitted
      }),
    ).toBeNull();
  });

  it("rejects turn/spawn_complete with empty content AND empty media (truly nothing to render)", () => {
    expect(
      guards.guardSpawnComplete({
        session_id: "sess-1",
        task_id: "t",
        seq: 1,
        message_id: "m",
        source: "background",
        cursor: { stream: "sess-1", seq: 1 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "",
      }),
    ).toBeNull();
  });

  it("ACCEPTS turn/spawn_complete with empty content but non-empty media (file-only completion)", () => {
    // Codex round-4 P2: a `spawn_only` tool whose result is purely
    // artefactual (e.g. TTS audio drop, _report.md only) legitimately
    // produces empty `content` + non-empty `media`. Upgraded clients
    // must accept this; rejecting it would silently drop file-only
    // completions because the server suppresses the legacy
    // `message/persisted` fallback once `event.spawn_complete.v1` is
    // negotiated.
    const ev = guards.guardSpawnComplete({
      session_id: "sess-1",
      task_id: "t",
      seq: 1,
      message_id: "m",
      source: "background",
      cursor: { stream: "sess-1", seq: 1 },
      persisted_at: "2026-05-04T00:00:00Z",
      content: "",
      media: ["bg/result.mp3"],
    });
    expect(ev).not.toBeNull();
    expect(ev?.content).toBe("");
    expect(ev?.media).toEqual(["bg/result.mp3"]);
  });

  it("rejects turn/spawn_complete with missing task_id", () => {
    expect(
      guards.guardSpawnComplete({
        session_id: "sess-1",
        seq: 1,
        message_id: "m",
        source: "background",
        cursor: { stream: "sess-1", seq: 1 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "result",
      }),
    ).toBeNull();
  });

  it("rejects turn/spawn_complete with non-finite cursor.seq", () => {
    expect(
      guards.guardSpawnComplete({
        session_id: "sess-1",
        task_id: "t",
        seq: 1,
        message_id: "m",
        source: "background",
        cursor: { stream: "sess-1", seq: Number.POSITIVE_INFINITY },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "result",
      }),
    ).toBeNull();
  });

  it("rejects turn/spawn_complete with malformed cursor", () => {
    expect(
      guards.guardSpawnComplete({
        session_id: "sess-1",
        task_id: "t",
        seq: 1,
        message_id: "m",
        source: "background",
        cursor: { stream: "" }, // missing seq, empty stream
        persisted_at: "2026-05-04T00:00:00Z",
        content: "result",
      }),
    ).toBeNull();
  });

  it("filters non-string media entries from turn/spawn_complete", () => {
    const ev = guards.guardSpawnComplete({
      session_id: "sess-1",
      task_id: "t",
      seq: 1,
      message_id: "m",
      source: "background",
      cursor: { stream: "sess-1", seq: 1 },
      persisted_at: "2026-05-04T00:00:00Z",
      content: "result",
      media: ["a/path.md", 42, null, "", "b/path.md"],
    });
    expect(ev?.media).toEqual(["a/path.md", "b/path.md"]);
  });

  it("accepts turn/spawn_complete with all optionals omitted", () => {
    const ev = guards.guardSpawnComplete({
      session_id: "sess-1",
      task_id: "t",
      seq: 1,
      message_id: "m",
      source: "background",
      cursor: { stream: "sess-1", seq: 1 },
      persisted_at: "2026-05-04T00:00:00Z",
      content: "result",
    });
    expect(ev?.turn_id).toBeUndefined();
    expect(ev?.thread_id).toBeUndefined();
    expect(ev?.response_to_client_message_id).toBeUndefined();
    expect(ev?.media).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // M10 Phase 6.2 (Bug C): session/hydrate result guard
  // -------------------------------------------------------------------------

  it("guardSessionHydrate accepts a hydrate result with new PR #791 fields", () => {
    const result = guards.guardSessionHydrate({
      session_id: "sess-1",
      cursor: { stream: "sess-1", seq: 25 },
      messages: [
        {
          seq: 0,
          role: "user",
          content: "Use deep_search...",
          thread_id: "synth_0",
          persisted_at: "2026-05-04T00:00:00Z",
          // No message_id / source — older-protocol row.
        },
        {
          seq: 19,
          role: "assistant",
          content: "Research delivered.",
          thread_id: "synth_0",
          persisted_at: "2026-05-04T00:09:22Z",
          message_id: "local:demo:19:1700000019000000000",
          source: "background",
        },
        {
          seq: 20,
          role: "assistant",
          content: "",
          thread_id: "synth_0",
          persisted_at: "2026-05-04T00:09:22Z",
          message_id: "local:demo:20:1700000020000000000",
          source: "background",
          media: ["pf/file.md"],
        },
      ],
      replayed_envelopes: [
        {
          session_id: "sess-1",
          turn_id: "turn-1",
          thread_id: "synth_0",
          task_id: "task_abc",
          seq: 19,
          message_id: "local:demo:19:1700000019000000000",
          source: "background",
          cursor: { stream: "sess-1", seq: 19 },
          persisted_at: "2026-05-04T00:09:22Z",
          content: "Research delivered.",
          media: ["pf/file.md"],
        },
      ],
    });
    expect(result).not.toBeNull();
    expect(result?.messages).toHaveLength(3);
    expect(result?.messages?.[1].message_id).toBe(
      "local:demo:19:1700000019000000000",
    );
    expect(result?.messages?.[1].source).toBe("background");
    expect(result?.messages?.[0].message_id).toBeUndefined();
    expect(result?.replayed_envelopes).toHaveLength(1);
    expect(result?.replayed_envelopes?.[0].task_id).toBe("task_abc");
  });

  it("guardSessionHydrate accepts a back-compat result without new fields (older server)", () => {
    const result = guards.guardSessionHydrate({
      session_id: "sess-1",
      cursor: { stream: "sess-1", seq: 5 },
      messages: [
        {
          seq: 0,
          role: "user",
          content: "hi",
          persisted_at: "2026-05-04T00:00:00Z",
        },
      ],
      // No replayed_envelopes (server pre-#791, or non-negotiated client).
    });
    expect(result).not.toBeNull();
    expect(result?.messages).toHaveLength(1);
    expect(result?.replayed_envelopes).toBeUndefined();
  });

  it("guardSessionHydrate rejects a non-object payload", () => {
    expect(guards.guardSessionHydrate(null)).toBeNull();
    expect(guards.guardSessionHydrate("string")).toBeNull();
    expect(guards.guardSessionHydrate(42)).toBeNull();
  });

  it("guardSessionHydrate drops malformed inner messages without poisoning the result", () => {
    const result = guards.guardSessionHydrate({
      session_id: "sess-1",
      cursor: { stream: "sess-1", seq: 1 },
      messages: [
        {
          seq: 0,
          role: "user",
          content: "ok",
          persisted_at: "2026-05-04T00:00:00Z",
        },
        // Missing required fields — dropped.
        { seq: "not-a-number", role: "assistant" },
        // Invalid role — dropped.
        {
          seq: 2,
          role: "narrator",
          content: "",
          persisted_at: "2026-05-04T00:00:00Z",
        },
      ],
    });
    expect(result).not.toBeNull();
    expect(result?.messages).toHaveLength(1);
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

  // Codex round 2 bug 2026-05-15: pre-fix this guard required
  // `isString(p.turn_id)`. The server's `TaskUpdatedEvent` struct does
  // NOT carry `turn_id` (supervisor publishes by `task_id` directly),
  // so EVERY production envelope was silently dropped at the guard
  // layer → TaskStore never populated → `resolveToolCallIdForTask`
  // always fell back to the raw supervisor UUID → spinner stuck.
  // Post-fix: guard accepts the envelope WITHOUT `turn_id`, picks up
  // the new `tool_call_id` directly from the wire so the handler can
  // flip the chip without the TaskStore race.
  it(
    "accepts task/updated WITHOUT turn_id BUT WITH tool_call_id (codex round 2 regression test)",
    () => {
      const ev = guards.guardTaskUpdated({
        session_id: "s",
        // turn_id intentionally OMITTED — matches server wire shape.
        task_id: "task_supervisor_uuid",
        tool_call_id: "call_llm_emitted_id",
        state: "failed",
      });
      // Pre-fix: `expected envelope to be accepted, was null` — guard
      // dropped the envelope on the `turn_id` requirement.
      expect(ev).not.toBeNull();
      expect(ev?.turn_id).toBeUndefined();
      expect(ev?.tool_call_id).toBe("call_llm_emitted_id");
      expect(ev?.task_id).toBe("task_supervisor_uuid");
      expect(ev?.state).toBe("failed");
    },
  );

  it(
    "accepts task/output/delta WITHOUT turn_id BUT WITH tool_call_id (codex round 2 regression test)",
    () => {
      const ev = guards.guardTaskOutputDelta({
        session_id: "s",
        // turn_id intentionally OMITTED — matches server wire shape.
        task_id: "task_supervisor_uuid",
        tool_call_id: "call_llm_emitted_id",
        chunk: "stdout line",
      });
      expect(ev).not.toBeNull();
      expect(ev?.turn_id).toBeUndefined();
      expect(ev?.tool_call_id).toBe("call_llm_emitted_id");
      expect(ev?.chunk).toBe("stdout line");
    },
  );

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

  // PR fix/restore-progress-cost-meta-events guards (regression A / B)
  it("accepts a well-formed tool/started event", () => {
    const ok = guards.guardToolStarted({
      session_id: "s",
      turn_id: "t",
      tool_call_id: "tc-1",
      tool_name: "shell",
      arguments: { command: "ls" },
    });
    expect(ok?.tool_call_id).toBe("tc-1");
    expect(ok?.tool_name).toBe("shell");
  });

  it("rejects tool/started missing tool_name", () => {
    expect(
      guards.guardToolStarted({
        session_id: "s",
        turn_id: "t",
        tool_call_id: "tc-1",
      }),
    ).toBeNull();
  });

  it("accepts tool/progress with optional message + progress_pct", () => {
    const ok = guards.guardToolProgress({
      session_id: "s",
      turn_id: "t",
      tool_call_id: "tc-2",
      message: "running",
      progress_pct: 42,
    });
    expect(ok?.message).toBe("running");
    expect(ok?.progress_pct).toBe(42);
  });

  it("accepts tool/completed and lifts success + duration_ms", () => {
    const ok = guards.guardToolCompleted({
      session_id: "s",
      turn_id: "t",
      tool_call_id: "tc-3",
      tool_name: "shell",
      success: true,
      duration_ms: 1250,
    });
    expect(ok?.success).toBe(true);
    expect(ok?.duration_ms).toBe(1250);
  });

  it("accepts progress/updated and lifts token_cost.input_tokens", () => {
    const ok = guards.guardProgressUpdated({
      session_id: "s",
      turn_id: "t",
      metadata: {
        kind: "token_cost_update",
        token_cost: { input_tokens: 100, output_tokens: 20, session_cost: 0.01 },
      },
    });
    expect(ok?.metadata.kind).toBe("token_cost_update");
    expect(ok?.metadata.token_cost?.input_tokens).toBe(100);
    expect(ok?.metadata.token_cost?.session_cost).toBe(0.01);
  });

  // Server PR `feat/cost-update-carry-model` adds an authoritative
  // `metadata.token_cost.model` field, populated from
  // `LlmProvider::provider_metadata_for_index(...).model`. Codex caught
  // that the fail-closed guard was silently dropping the new field
  // before it reached the router — so the chat bubble footer would
  // continue to fall back to the legacy `metadata.label` carrier in
  // production even though the wire carried the right value. This test
  // pins the guard's handling of the new field.
  it("preserves token_cost.model through the guard", () => {
    const ok = guards.guardProgressUpdated({
      session_id: "s",
      turn_id: "t",
      metadata: {
        kind: "token_cost_update",
        token_cost: {
          input_tokens: 120,
          output_tokens: 45,
          model: "deepseek-v4-pro",
        },
      },
    });
    expect(ok?.metadata.token_cost?.model).toBe("deepseek-v4-pro");
  });

  // Defensive: a malformed `model` field (non-string / empty string)
  // must not synthesise a `model` value on the snapshot — empty would
  // confuse the bubble footer renderer downstream.
  it("drops empty / non-string token_cost.model", () => {
    const emptyString = guards.guardProgressUpdated({
      session_id: "s",
      turn_id: "t",
      metadata: {
        kind: "token_cost_update",
        token_cost: { input_tokens: 1, output_tokens: 2, model: "" },
      },
    });
    expect(emptyString?.metadata.token_cost?.model).toBeUndefined();

    const wrongType = guards.guardProgressUpdated({
      session_id: "s",
      turn_id: "t",
      metadata: {
        kind: "token_cost_update",
        token_cost: { input_tokens: 1, output_tokens: 2, model: 42 },
      },
    });
    expect(wrongType?.metadata.token_cost?.model).toBeUndefined();
  });

  it("rejects progress/updated missing metadata.kind", () => {
    expect(
      guards.guardProgressUpdated({
        session_id: "s",
        metadata: { token_cost: { input_tokens: 100 } },
      }),
    ).toBeNull();
  });

  // Wave4-A guards
  it("accepts a well-formed router/status event", () => {
    const ok = guards.guardRouterStatus({
      session_id: "s",
      provider_name: "openrouter/anthropic/claude-opus-4-7",
      mode: "lane",
      qos_ranking: true,
      lane_scores: {
        "openrouter/anthropic/claude-opus-4-7": 0.92,
        "openrouter/openai/gpt-5": 0.78,
      },
      circuit_breakers: {
        "openrouter/openai/gpt-5": "open",
      },
    });
    expect(ok?.provider_name).toBe(
      "openrouter/anthropic/claude-opus-4-7",
    );
    expect(ok?.mode).toBe("lane");
    expect(ok?.qos_ranking).toBe(true);
    expect(ok?.lane_scores["openrouter/anthropic/claude-opus-4-7"]).toBe(
      0.92,
    );
    expect(ok?.circuit_breakers["openrouter/openai/gpt-5"]).toBe("open");
  });

  it("rejects router/status missing qos_ranking flag", () => {
    expect(
      guards.guardRouterStatus({
        session_id: "s",
        provider_name: "p",
        mode: "lane",
        lane_scores: {},
        circuit_breakers: {},
      }),
    ).toBeNull();
  });

  it("accepts a well-formed router/failover event", () => {
    const ok = guards.guardRouterFailover({
      session_id: "s",
      from_provider: "a",
      to_provider: "b",
      reason: "circuit_breaker_open",
      elapsed_ms: 1500,
    });
    expect(ok?.from_provider).toBe("a");
    expect(ok?.to_provider).toBe("b");
    expect(ok?.elapsed_ms).toBe(1500);
  });

  it("rejects router/failover with negative elapsed_ms", () => {
    expect(
      guards.guardRouterFailover({
        session_id: "s",
        from_provider: "a",
        to_provider: "b",
        reason: "r",
        elapsed_ms: -1,
      }),
    ).toBeNull();
  });

  it("accepts a well-formed queue/state event", () => {
    const ok = guards.guardQueueState({
      session_id: "s",
      pending_count: 2,
      head_client_message_id: "cmid-head",
    });
    expect(ok?.pending_count).toBe(2);
    expect(ok?.head_client_message_id).toBe("cmid-head");
  });

  it("queue/state head is null when absent", () => {
    const ok = guards.guardQueueState({
      session_id: "s",
      pending_count: 0,
    });
    expect(ok?.pending_count).toBe(0);
    expect(ok?.head_client_message_id).toBeNull();
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
    // Regression-pin for the M10 Phase 1 capability negotiation
    // (server PR #772): server only emits the new
    // `turn/spawn_complete` envelope when this capability is in the
    // `ui_feature` query at session/open. Without it the SPA never
    // receives the new bubble and falls back to legacy `message/persisted`
    // splice-merge. Phase 5 deletes the splice-merge predicate; until
    // then, this assertion locks the negotiation.
    expect(ws.url).toContain("ui_feature=event.spawn_complete.v1");
    // Regression-pin: do NOT pass Sec-WebSocket-Protocol. Chrome aborts the
    // handshake when the client requests a subprotocol the server does not
    // echo back, and the axum WS handler does not negotiate subprotocols.
    // Auth flows entirely via the `?token=` query param above.
    expect(ws.protocols).toBeUndefined();
  });

  it("auxiliary.rest_to_ws.v1 — appended to ui_feature ONLY when flag is ON", async () => {
    // Import the flag helper inside the test so we don't pollute the
    // module-scope cache for other tests in this file.
    const {
      __setAuxRestToWsV1ForTests,
      AUX_REST_TO_WS_V1_FEATURE,
    } = await import("@/lib/feature-flags");

    try {
      // Flag explicit OFF (emergency-rollback escape hatch) — the aux
      // capability is NOT advertised. (Phase D-4 flipped the default to
      // ON; tests still cover the explicit-OFF leg.)
      __setAuxRestToWsV1ForTests(false);
      let bridge = createUiProtocolBridge(makeBridgeOpts());
      void bridge.start({ sessionId: "sess-a" });
      await Promise.resolve();
      let ws = lastInstance();
      expect(ws.url.includes(`ui_feature=${AUX_REST_TO_WS_V1_FEATURE}`)).toBe(
        false,
      );
      await bridge.stop();

      // Flag ON — the aux capability MUST be in the negotiated list, or
      // the M12 Phase D-1 dispatcher rejects every aux RPC even though
      // `SessionOpened.capabilities` advertises them (octos #913).
      __setAuxRestToWsV1ForTests(true);
      bridge = createUiProtocolBridge(makeBridgeOpts());
      void bridge.start({ sessionId: "sess-b" });
      await Promise.resolve();
      ws = lastInstance();
      expect(ws.url).toContain(`ui_feature=${AUX_REST_TO_WS_V1_FEATURE}`);
      // Exact-count assertion: the aux feature MUST appear once, never
      // duplicated. A double `push` in `getUiProtocolFeatures()` would
      // pass the `toContain` check above but break the server-side
      // capability set comparison.
      const auxOccurrences = new URL(ws.url).searchParams
        .getAll("ui_feature")
        .filter((feature) => feature === AUX_REST_TO_WS_V1_FEATURE).length;
      expect(auxOccurrences).toBe(1);
      await bridge.stop();
    } finally {
      __setAuxRestToWsV1ForTests(false);
    }
  });

  it("callMethod() forwards arbitrary JSON-RPC over the open socket", async () => {
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    void bridge.start({ sessionId: "sess-c" });
    await Promise.resolve();
    const ws = lastInstance();
    ws.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws, METHODS.SESSION_OPEN);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-c" } },
    });
    await Promise.resolve();

    const pending = bridge.callMethod<{ sessions: unknown[] }>(
      METHODS.SESSION_LIST,
      {},
    );
    // Drain microtasks so the queued frame lands in `ws.sent`.
    await Promise.resolve();
    const sent = findRequest(ws, METHODS.SESSION_LIST);
    ws.triggerMessage({
      jsonrpc: "2.0",
      id: sent.id,
      result: { sessions: [{ id: "s-9" }] },
    });
    const out = await pending;
    expect(out.sessions).toEqual([{ id: "s-9" }]);
    await bridge.stop();
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

  it("sendTurn fast-rejects after maxReconnectAttempts is exhausted", async () => {
    // Codex M10.5 Wave A round-4 P2: once `scheduleReconnect` has given
    // up (state==="error" AND reconnectAbandoned), the bridge must
    // surface a real error to callers instead of parking the frame in
    // sendQueue forever. This used to silently drop user turns.
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ maxReconnectAttempts: 2 }),
    );
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
    // Reconnect now abandoned (state==="error", reconnectAbandoned=true).
    await expect(
      bridge.sendTurn("turn-x", [{ kind: "text", text: "post-abandon" }]),
    ).rejects.toThrow(/WebSocket connection is closed/);
  });

  it("sendTurn during transient onerror (pre-onclose) still queues and reconnects", async () => {
    // Codex M10.5 Wave A round-4 P2 follow-up: `onerror` flips state to
    // `error` BEFORE `onclose` runs scheduleReconnect, so a naive
    // `state==="error" => fast-reject` rule would incorrectly fail
    // sends issued in the brief browser-event gap of an otherwise
    // recoverable network hiccup. The fix gates fast-reject on
    // `reconnectAbandoned`, so the transient `error` blip leaves the
    // frame queued; this test pins that behavior so a future refactor
    // can't re-introduce the regression.
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    const states: ConnectionState[] = [];
    bridge.onConnectionStateChange((s) => states.push(s));
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws1 = lastInstance();
    // Drive into the transient error window: onerror fires first, state
    // becomes "error", but the socket has not yet closed and reconnect
    // has NOT been abandoned.
    ws1.onerror?.({});
    expect(states).toContain("error");
    // sendTurn at this moment must NOT fast-reject — it should queue
    // for the imminent reconnect to flush after handshake.
    let sendSettled = false;
    const sendPromise = bridge
      .sendTurn("turn-q", [{ kind: "text", text: "queued through hiccup" }])
      .then(
        () => {
          sendSettled = true;
        },
        () => {
          sendSettled = true;
        },
      );
    await Promise.resolve();
    expect(sendSettled).toBe(false);
    // Now let the close land → scheduleReconnect → ws2 opens →
    // session/open ack → flush.
    ws1.triggerClose(1006, "abnormal");
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = lastInstance();
    ws2.triggerOpen();
    await Promise.resolve();
    const open = findRequest(ws2, METHODS.SESSION_OPEN);
    ws2.triggerMessage({
      jsonrpc: "2.0",
      id: open.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    // Frame eventually went out on the new socket.
    const turnFrames = ws2.sent
      .map((f) => JSON.parse(f) as { method: string; params?: { turn_id?: string } })
      .filter((f) => f.method === METHODS.TURN_START)
      .map((f) => f.params?.turn_id);
    expect(turnFrames).toContain("turn-q");
    // Resolve the in-flight RPC so the Promise above settles cleanly.
    const turnReq = findRequest(ws2, METHODS.TURN_START);
    ws2.triggerMessage({
      jsonrpc: "2.0",
      id: turnReq.id,
      result: { accepted: true },
    });
    await sendPromise;
    expect(sendSettled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reload-bug fix (Yue 2026-05-15): onReopened fires on every successful
// `session/open` ack AFTER the initial open — never on the initial open.
// This is the hook the runtime layer subscribes to so it can re-issue
// `session/hydrate` and recover envelopes the server emitted while the
// WS was disconnected. Without this gating the runtime would
// double-hydrate at startup; without the event at all the
// run_pipeline-while-disconnected bug stays broken.
// ---------------------------------------------------------------------------

describe("onReopened — reconnect-only event", () => {
  it("does NOT fire on the initial session/open ack", async () => {
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    const reopenedCounts: { count: number } = { count: 0 };
    bridge.onReopened(() => {
      reopenedCounts.count += 1;
    });
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
    expect(reopenedCounts.count).toBe(0);
  });

  it("fires once on every successful session/open ack AFTER the first", async () => {
    // Drive the bridge through `initial open -> drop -> reconnect ->
    // session/open ack`. The first ack must NOT fire `onReopened`; the
    // second ack MUST.
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    const reopened: number[] = [];
    bridge.onReopened(() => {
      reopened.push(Date.now());
    });

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
    expect(reopened).toHaveLength(0);

    // Drop the socket; bridge schedules a reconnect.
    ws1.triggerClose(1006, "abnormal");
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = lastInstance();
    ws2.triggerOpen();
    await Promise.resolve();
    const open2 = findRequest(ws2, METHODS.SESSION_OPEN);
    ws2.triggerMessage({
      jsonrpc: "2.0",
      id: open2.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    expect(reopened).toHaveLength(1);

    // A second drop + reconnect fires it again.
    ws2.triggerClose(1006, "abnormal");
    await vi.advanceTimersByTimeAsync(2000);
    const ws3 = lastInstance();
    ws3.triggerOpen();
    await Promise.resolve();
    const open3 = findRequest(ws3, METHODS.SESSION_OPEN);
    ws3.triggerMessage({
      jsonrpc: "2.0",
      id: open3.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    expect(reopened).toHaveLength(2);
  });

  it("unsubscribe stops further onReopened deliveries", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    let calls = 0;
    const unsub = bridge.onReopened(() => {
      calls += 1;
    });

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

    // First reconnect fires the event.
    ws1.triggerClose(1006, "abnormal");
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = lastInstance();
    ws2.triggerOpen();
    await Promise.resolve();
    const open2 = findRequest(ws2, METHODS.SESSION_OPEN);
    ws2.triggerMessage({
      jsonrpc: "2.0",
      id: open2.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    expect(calls).toBe(1);

    // Unsubscribe, then drive another reconnect.
    unsub();
    ws2.triggerClose(1006, "abnormal");
    await vi.advanceTimersByTimeAsync(2000);
    const ws3 = lastInstance();
    ws3.triggerOpen();
    await Promise.resolve();
    const open3 = findRequest(ws3, METHODS.SESSION_OPEN);
    ws3.triggerMessage({
      jsonrpc: "2.0",
      id: open3.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #137 (Yue 2026-05-15): visibility-driven reset of `reconnectAbandoned`.
//
// PR #136 wired `onReopened` → `session/hydrate(["messages"])` so reconnects
// WITHIN the 121s window now pick up missed envelopes. But after the bridge's
// 8 attempts elapse (cumulative ~121s), `reconnectAbandoned=true` latches and
// the bridge stops trying — live state is stranded until manual refresh.
//
// Fix: when `document.visibilitychange` fires with `visibilityState='visible'`
// and the bridge has latched via the *attempt-exhaustion* path (NOT the auth-
// rejected path — the token is still dead there), clear the latch, reset the
// attempt counter, and kick off ONE fresh reconnect through the existing
// `openSocket()` → `onWsOpen()` → `onReopened` flow.
// ---------------------------------------------------------------------------

describe("visibility-driven reset of reconnectAbandoned (#137)", () => {
  /** Helper: drive the bridge to `state==="error"` + `reconnectAbandoned=true`
   *  via the attempt-exhaustion path (NOT the auth-rejected path). */
  async function drainToAbandoned(maxAttempts = 2): Promise<void> {
    // Caller has already called bridge.start(); just trigger close cycles.
    // After `maxAttempts` close events, scheduleReconnect latches.
    for (let i = 0; i < maxAttempts + 1; i++) {
      const ws = lastInstance();
      ws.triggerClose(1006, "abnormal");
      // Use the longest backoff (16s should cover the first few schedule slots).
      await vi.advanceTimersByTimeAsync(16000);
    }
  }

  function dispatchVisibilityChange(state: "visible" | "hidden"): void {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("after attempt-exhaustion latch, visibilitychange='visible' triggers ONE fresh reconnect", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ maxReconnectAttempts: 2 }),
    );
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();

    // Initial open succeeds → hasEverOpened = true.
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

    // Exhaust reconnects. We start with 1 ws instance.
    const instancesBeforeExhaustion = MockWebSocket.instances.length;
    await drainToAbandoned(2);
    const instancesAfterExhaustion = MockWebSocket.instances.length;
    expect(instancesAfterExhaustion).toBeGreaterThan(instancesBeforeExhaustion);
    expect(bridge.getConnectionState()).toBe("error");

    // Dispatch visibilitychange='visible' → bridge should clear the latch
    // and call openSocket() exactly once.
    const instancesBeforeVisibility = MockWebSocket.instances.length;
    dispatchVisibilityChange("visible");
    await Promise.resolve();
    const instancesAfterVisibility = MockWebSocket.instances.length;
    expect(instancesAfterVisibility - instancesBeforeVisibility).toBe(1);
    expect(bridge.getConnectionState()).toBe("connecting");

    await bridge.stop();
  });

  it("visibilitychange='visible' while NOT abandoned is a no-op", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(makeBridgeOpts());
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
    expect(bridge.getConnectionState()).toBe("connected");

    const instancesBefore = MockWebSocket.instances.length;
    dispatchVisibilityChange("visible");
    await Promise.resolve();
    const instancesAfter = MockWebSocket.instances.length;
    expect(instancesAfter).toBe(instancesBefore);
    expect(bridge.getConnectionState()).toBe("connected");

    await bridge.stop();
  });

  it("visibilitychange='hidden' is a no-op even when abandoned", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ maxReconnectAttempts: 2 }),
    );
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

    await drainToAbandoned(2);
    expect(bridge.getConnectionState()).toBe("error");

    const instancesBefore = MockWebSocket.instances.length;
    dispatchVisibilityChange("hidden");
    await Promise.resolve();
    const instancesAfter = MockWebSocket.instances.length;
    expect(instancesAfter).toBe(instancesBefore);
    expect(bridge.getConnectionState()).toBe("error");

    await bridge.stop();
  });

  it("auth-rejected latch (close-code 1008) is NOT recovered by visibilitychange (token still dead)", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(makeBridgeOpts());
    void bridge.start({ sessionId: "sess-1" });
    await Promise.resolve();
    const ws1 = lastInstance();
    // Server rejects upgrade with 1008. Bridge latches reconnectAbandoned
    // for the auth-rejected reason (token is dead) — do NOT retry on
    // visibility flip.
    ws1.triggerClose(1008, "auth_rejected");
    await Promise.resolve();
    expect(bridge.getConnectionState()).toBe("error");

    const instancesBefore = MockWebSocket.instances.length;
    dispatchVisibilityChange("visible");
    await Promise.resolve();
    const instancesAfter = MockWebSocket.instances.length;
    expect(instancesAfter).toBe(instancesBefore);
    expect(bridge.getConnectionState()).toBe("error");

    await bridge.stop();
  });

  it("post-visibility reconnect fires onReopened so the hydrate path runs", async () => {
    // The whole point of this fix: a visibility-driven reconnect must
    // route through the same `openSocket()` → `session/open` → `onReopened`
    // path the bounded loop uses, so PR #136's hydrate hook still fires
    // and `session/hydrate` replays envelopes that landed during the
    // long offline window.
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ maxReconnectAttempts: 2 }),
    );
    const reopened: number[] = [];
    bridge.onReopened(() => {
      reopened.push(Date.now());
    });

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
    expect(reopened).toHaveLength(0);

    await drainToAbandoned(2);
    expect(bridge.getConnectionState()).toBe("error");
    expect(reopened).toHaveLength(0);

    dispatchVisibilityChange("visible");
    await Promise.resolve();
    const wsAfter = lastInstance();
    wsAfter.triggerOpen();
    await Promise.resolve();
    const openAfter = findRequest(wsAfter, METHODS.SESSION_OPEN);
    wsAfter.triggerMessage({
      jsonrpc: "2.0",
      id: openAfter.id,
      result: { opened: { session_id: "sess-1" } },
    });
    await Promise.resolve();
    expect(bridge.getConnectionState()).toBe("connected");
    // onReopened must have fired exactly once — the visibility-driven
    // reconnect is a "reopen" in every meaningful sense.
    expect(reopened).toHaveLength(1);

    await bridge.stop();
  });

  it("multiple rapid visibilitychange events do not stack additional reconnects (idempotent)", async () => {
    // Mobile browsers can fire visibilitychange multiple times in quick
    // succession when the user app-switches. Once we have started a
    // reconnect attempt, additional `visible` events must not pile on
    // more sockets.
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ maxReconnectAttempts: 2 }),
    );
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

    await drainToAbandoned(2);
    expect(bridge.getConnectionState()).toBe("error");

    const instancesBefore = MockWebSocket.instances.length;
    dispatchVisibilityChange("visible");
    await Promise.resolve();
    // While the new socket is still `connecting` (no triggerOpen yet),
    // fire another visibilitychange. It must be a no-op.
    dispatchVisibilityChange("visible");
    await Promise.resolve();
    dispatchVisibilityChange("visible");
    await Promise.resolve();
    const instancesAfter = MockWebSocket.instances.length;
    expect(instancesAfter - instancesBefore).toBe(1);

    await bridge.stop();
  });

  it("removes the visibilitychange listener on stop()", async () => {
    vi.useFakeTimers();
    const bridge = createUiProtocolBridge(
      makeBridgeOpts({ maxReconnectAttempts: 2 }),
    );
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

    await drainToAbandoned(2);
    expect(bridge.getConnectionState()).toBe("error");

    await bridge.stop();

    // After stop, visibilitychange must NOT spin up a new socket.
    const instancesBefore = MockWebSocket.instances.length;
    dispatchVisibilityChange("visible");
    await Promise.resolve();
    const instancesAfter = MockWebSocket.instances.length;
    expect(instancesAfter).toBe(instancesBefore);
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
      params: { session_id: "sess-1", turn_id: "t1", text: "hi" },
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
      params: { session_id: "sess-1", text: "hi" },
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

  it("routes turn/spawn_complete to onSpawnComplete (M10 Phase 2)", async () => {
    const { bridge, ws } = await freshConnected();
    const seen: TurnSpawnCompleteEvent[] = [];
    bridge.onSpawnComplete((e) => seen.push(e));
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.TURN_SPAWN_COMPLETE,
      params: {
        session_id: "sess-1",
        turn_id: "turn-A",
        thread_id: "cmid-user-1",
        task_id: "task_abc",
        response_to_client_message_id: "cmid-user-1",
        seq: 7,
        message_id: "msg-spawn-1",
        source: "background",
        cursor: { stream: "sess-1", seq: 7 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "Background research complete.",
        media: ["research/_report.md"],
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].task_id).toBe("task_abc");
    expect(seen[0].content).toBe("Background research complete.");
    expect(seen[0].media).toEqual(["research/_report.md"]);
  });

  it("emits warning when turn/spawn_complete is missing required content", async () => {
    const { bridge, ws } = await freshConnected();
    const warnings: WarningEvent[] = [];
    const seen: TurnSpawnCompleteEvent[] = [];
    bridge.onWarning((w) => warnings.push(w));
    bridge.onSpawnComplete((e) => seen.push(e));
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.TURN_SPAWN_COMPLETE,
      params: {
        session_id: "sess-1",
        task_id: "task_abc",
        seq: 7,
        message_id: "msg-spawn-1",
        source: "background",
        cursor: { stream: "sess-1", seq: 7 },
        persisted_at: "2026-05-04T00:00:00Z",
        // content omitted — must be rejected
      },
    });
    expect(seen).toHaveLength(0);
    expect(
      warnings.some((w) => w.reason === "invalid_event:turn/spawn_complete"),
    ).toBe(true);
  });

  it("routes tool/started, tool/progress, tool/completed, progress/updated through the new subscribers", async () => {
    // PR fix/restore-progress-cost-meta-events: end-to-end bridge dispatch
    // test for the four notification methods restored after the SSE
    // bridge deletion in PR #96.
    const { bridge, ws } = await freshConnected();
    const started: unknown[] = [];
    const progressed: unknown[] = [];
    const completed: unknown[] = [];
    const updates: unknown[] = [];
    bridge.onToolStarted((e) => started.push(e));
    bridge.onToolProgress((e) => progressed.push(e));
    bridge.onToolCompleted((e) => completed.push(e));
    bridge.onProgressUpdated((e) => updates.push(e));

    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.TOOL_STARTED,
      params: {
        session_id: "sess-1",
        turn_id: "t1",
        tool_call_id: "tc-1",
        tool_name: "shell",
      },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.TOOL_PROGRESS,
      params: {
        session_id: "sess-1",
        turn_id: "t1",
        tool_call_id: "tc-1",
        message: "running",
      },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.TOOL_COMPLETED,
      params: {
        session_id: "sess-1",
        turn_id: "t1",
        tool_call_id: "tc-1",
        tool_name: "shell",
        success: true,
        duration_ms: 100,
      },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.PROGRESS_UPDATED,
      params: {
        session_id: "sess-1",
        turn_id: "t1",
        metadata: {
          kind: "token_cost_update",
          label: "moonshot@autodl/kimi-k2.5",
          token_cost: { input_tokens: 1, output_tokens: 2, session_cost: 0.001 },
        },
      },
    });
    expect(started).toHaveLength(1);
    expect(progressed).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  it("Wave4-A: routes router/status, router/failover, queue/state through the new subscribers", async () => {
    const { bridge, ws } = await freshConnected();
    const statuses: unknown[] = [];
    const failovers: unknown[] = [];
    const queues: unknown[] = [];
    bridge.onRouterStatus((e) => statuses.push(e));
    bridge.onRouterFailover((e) => failovers.push(e));
    bridge.onQueueState((e) => queues.push(e));
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.ROUTER_STATUS,
      params: {
        session_id: "sess-1",
        provider_name: "openrouter/anthropic/claude-opus-4-7",
        mode: "hedge",
        qos_ranking: true,
        lane_scores: { "openrouter/anthropic/claude-opus-4-7": 0.9 },
        circuit_breakers: {},
      },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.ROUTER_FAILOVER,
      params: {
        session_id: "sess-1",
        from_provider: "a/m1",
        to_provider: "b/m2",
        reason: "score_drop",
        elapsed_ms: 250,
      },
    });
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.QUEUE_STATE,
      params: {
        session_id: "sess-1",
        pending_count: 1,
        head_client_message_id: "cmid-Q1",
      },
    });
    expect(statuses).toHaveLength(1);
    expect(failovers).toHaveLength(1);
    expect(queues).toHaveLength(1);
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
      params: { session_id: "sess-1", turn_id: "t1", text: "a" },
    });
    unsub();
    ws.triggerMessage({
      jsonrpc: "2.0",
      method: METHODS.MESSAGE_DELTA,
      params: { session_id: "sess-1", turn_id: "t1", text: "b" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe("a");
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
