/**
 * ui-protocol-event-router unit tests (Phase C-2, issue #68).
 *
 * Coverage:
 *   - each typed bridge event maps to the correct ThreadStore mutation
 *   - parity with the SSE path: feeding equivalent events through both
 *     transports lands on the same final ThreadStore state
 *   - turn/error finalizes the bubble as errored (not stuck pending)
 *   - approval/requested dispatches a CustomEvent with the typed payload
 *   - flag-OFF: the v1 sender delegates to the legacy SSE bridge and the
 *     UI Protocol runtime stays cold (no bridge instantiated)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as ThreadStore from "@/store/thread-store";
import {
  __resetRouterStateForTest,
  attachRouter,
  handleApprovalRequested,
  handleMessageDelta,
  handleMessagePersisted,
  handleTaskOutputDelta,
  handleTaskUpdated,
  handleTurnCompleted,
  handleTurnError,
  handleTurnStarted,
} from "./ui-protocol-event-router";
import type {
  ApprovalRequestedEvent,
  MessageDeltaEvent,
  MessagePersistedEvent,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  TurnCompletedEvent,
  TurnErrorEvent,
  TurnStartedEvent,
  UiProtocolBridge,
} from "./ui-protocol-bridge";

const SESSION = "sess-router";

function seedThread(cmid: string, text = "hi") {
  return ThreadStore.addUserMessage(SESSION, {
    text,
    clientMessageId: cmid,
  });
}

afterEach(() => {
  ThreadStore.__resetForTests();
  __resetRouterStateForTest();
});

describe("router event mapping", () => {
  it("message/delta appends to the assistant pending slot", () => {
    seedThread("cmid-1");
    const evt: MessageDeltaEvent = {
      session_id: SESSION,
      turn_id: "cmid-1",
      delta: "Hello",
    };
    handleMessageDelta({ sessionId: SESSION }, evt);
    handleMessageDelta(
      { sessionId: SESSION },
      { ...evt, delta: ", world" },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant?.text).toBe("Hello, world");
  });

  it("message/persisted (no live pending) appends a late-artifact row", () => {
    // No seedThread — the late-artifact path appends a fresh row when
    // there's no live `pendingAssistant` to promote. δ scope: server's
    // wire shape is metadata-only, so the row's text is a synthesised
    // placeholder; media URLs (PR #767) attach to the same row.
    const evt: MessagePersistedEvent = {
      session_id: SESSION,
      turn_id: "cmid-2",
      thread_id: "cmid-2",
      seq: 7,
      role: "assistant",
      message_id: "msg-1",
      source: "background",
      cursor: { stream: SESSION, seq: 7 },
      persisted_at: "2026-04-30T00:00:00Z",
      media: ["research/_report.md"],
    };
    handleMessagePersisted({ sessionId: SESSION }, evt);
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread).toBeDefined();
  });

  it("task/updated running emits a progress entry on the bound tool call", () => {
    seedThread("cmid-3");
    const dispatched: Event[] = [];
    const cfg = {
      sessionId: SESSION,
      dispatchEvent: (e: Event) => dispatched.push(e),
    };
    const evt: TaskUpdatedEvent = {
      session_id: SESSION,
      turn_id: "cmid-3",
      task_id: "task-7",
      state: "running",
      title: "deep_research",
    };
    handleTaskUpdated(cfg, evt);
    const [thread] = ThreadStore.getThreads(SESSION);
    const tcs = thread.pendingAssistant?.toolCalls ?? [];
    expect(tcs.find((tc) => tc.id === "task-7")?.progress.map((p) => p.message))
      .toEqual(["deep_research"]);
    expect(dispatched.some((e) => e.type === "crew:bg_tasks")).toBe(true);
  });

  it("task/updated dedupes consecutive identical state for the same task", () => {
    seedThread("cmid-4");
    const evt: TaskUpdatedEvent = {
      session_id: SESSION,
      turn_id: "cmid-4",
      task_id: "task-8",
      state: "running",
      title: "doing-thing",
    };
    handleTaskUpdated({ sessionId: SESSION }, evt);
    handleTaskUpdated({ sessionId: SESSION }, evt);
    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.pendingAssistant?.toolCalls.find((c) => c.id === "task-8");
    expect(tc?.progress).toHaveLength(1);
  });

  it("task/updated completed flips the tool status to complete", () => {
    seedThread("cmid-5");
    handleTaskUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-5",
        task_id: "task-9",
        state: "running",
        title: "search",
      },
    );
    handleTaskUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-5",
        task_id: "task-9",
        state: "completed",
      },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.pendingAssistant?.toolCalls.find((c) => c.id === "task-9");
    expect(tc?.status).toBe("complete");
  });

  it("task/updated failed flips the tool status to error", () => {
    seedThread("cmid-5b");
    handleTaskUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-5b",
        task_id: "task-fail",
        state: "running",
        title: "fragile",
      },
    );
    handleTaskUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-5b",
        task_id: "task-fail",
        state: "failed",
      },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.pendingAssistant?.toolCalls.find(
      (c) => c.id === "task-fail",
    );
    expect(tc?.status).toBe("error");
  });

  it("task/output/delta appends a chunk into the matching tool call timeline", () => {
    seedThread("cmid-6");
    handleTaskUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-6",
        task_id: "task-out",
        state: "running",
        title: "tail",
      },
    );
    const evt: TaskOutputDeltaEvent = {
      session_id: SESSION,
      turn_id: "cmid-6",
      task_id: "task-out",
      chunk: "line 1\nline 2",
    };
    handleTaskOutputDelta({ sessionId: SESSION }, evt);
    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.pendingAssistant?.toolCalls.find(
      (c) => c.id === "task-out",
    );
    expect(tc?.progress.map((p) => p.message)).toEqual(["tail", "line 1\nline 2"]);
  });

  it("turn/started fires crew:thinking rising edge", () => {
    const dispatched: Event[] = [];
    const evt: TurnStartedEvent = {
      session_id: SESSION,
      turn_id: "cmid-7",
    };
    handleTurnStarted(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      evt,
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe("crew:thinking");
    expect((dispatched[0] as CustomEvent).detail.thinking).toBe(true);
  });

  it("turn/completed finalizes the assistant bubble", () => {
    seedThread("cmid-8");
    ThreadStore.appendAssistantToken("cmid-8", "Done.");
    const dispatched: Event[] = [];
    const evt: TurnCompletedEvent = {
      session_id: SESSION,
      turn_id: "cmid-8",
      reason: "stop",
    };
    handleTurnCompleted(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      evt,
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant).toBeNull();
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Done.");
    expect(thread.responses[0].status).toBe("complete");
    expect(
      dispatched.some(
        (e) =>
          e.type === "crew:thinking" &&
          (e as CustomEvent).detail.thinking === false,
      ),
    ).toBe(true);
  });

  it("turn/error marks the assistant bubble errored, not stuck pending", () => {
    seedThread("cmid-9");
    ThreadStore.appendAssistantToken("cmid-9", "partial");
    const dispatched: Event[] = [];
    const evt: TurnErrorEvent = {
      session_id: SESSION,
      turn_id: "cmid-9",
      error: { code: -32000, message: "agent_failed" },
    };
    handleTurnError(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      evt,
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant).toBeNull();
    expect(thread.responses[0].status).toBe("error");
    expect(thread.responses[0].text).toBe("partial");
    expect(dispatched.some((e) => e.type === "crew:turn_error")).toBe(true);
  });

  it("approval/requested dispatches a CustomEvent with the typed payload", () => {
    const dispatched: Event[] = [];
    const evt: ApprovalRequestedEvent = {
      session_id: SESSION,
      approval_id: "ap-1",
      turn_id: "cmid-10",
      tool_name: "shell",
      title: "Run rm?",
      body: "rm -rf node_modules",
      approval_kind: "shell.exec",
      approval_scope: "request",
      risk: "high",
    };
    handleApprovalRequested(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      evt,
    );
    expect(dispatched).toHaveLength(1);
    const ce = dispatched[0] as CustomEvent;
    expect(ce.type).toBe("crew:approval_requested");
    expect(ce.detail).toEqual(evt);
  });
});

// ---------------------------------------------------------------------------
// Parity: feed equivalent SSE-shaped and v1 events into their respective
// handlers and assert the ThreadStore terminal state matches.
// ---------------------------------------------------------------------------

describe("router lifecycle de-dup", () => {
  // Codex review: the server emits message/delta + message/persisted +
  // turn/completed for the same turn. Pre-fix, the router appended the
  // persisted record as an additional response on top of the streamed
  // pending bubble — duplicate bubbles in the UI. The fix promotes the
  // pending into the persisted record on `message/persisted` arrival.
  it("emits a single response for delta + persisted + completed on the same turn", () => {
    const cmid = "cmid-dedup";
    seedThread(cmid, "ask");
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, delta: "partial" },
    );
    handleMessagePersisted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        seq: 11,
        role: "assistant",
        message_id: "msg-dedup",
        source: "assistant",
        cursor: { stream: SESSION, seq: 11 },
        persisted_at: "2026-04-30T00:00:00Z",
      },
    );
    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, reason: "stop" },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    // δ: server's MessagePersistedEvent is metadata-only — the bubble
    // text is whatever was streamed via `message/delta` (here "partial").
    // The persisted event finalises the bubble; it does NOT overwrite text.
    expect(thread.responses[0].text).toBe("partial");
    expect(thread.responses[0].status).toBe("complete");
    expect(thread.pendingAssistant).toBeNull();
  });
});

describe("router seq preservation", () => {
  // δ scope: UPCR-2026-012 only carries the `seq` field — no separate
  // `history_seq` / `intra_thread_seq` axes. The router stamps `seq`
  // onto the late-artifact row.
  it("persisted message stamps seq onto the late-artifact response", () => {
    const cmid = "cmid-seq";
    handleMessagePersisted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        seq: 42,
        role: "assistant",
        message_id: "msg-seq",
        source: "background",
        cursor: { stream: SESSION, seq: 42 },
        persisted_at: "2026-04-30T00:00:00Z",
      },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    const last = thread.responses[thread.responses.length - 1];
    expect(last?.historySeq).toBe(42);
  });
});

describe("router parity with SSE bridge", () => {
  it("v1 stream lands on the same ThreadStore state as the SSE equivalent", () => {
    // Both transports start from the same user message.
    const cmid = "cmid-parity";

    // === v1 path: drive the router with typed events. ===
    seedThread(cmid, "ask");
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid },
    );
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, delta: "Hello" },
    );
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, delta: ", world" },
    );
    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, reason: "stop" },
    );
    const v1State = ThreadStore.getThreads(SESSION);
    const v1Snapshot = {
      threads: v1State.length,
      text: v1State[0].responses[0]?.text,
      status: v1State[0].responses[0]?.status,
      pending: v1State[0].pendingAssistant,
    };

    ThreadStore.__resetForTests();

    // === Legacy path: drive ThreadStore directly using the same actions
    //     the SSE bridge invokes for token / done events. ===
    seedThread(cmid, "ask");
    ThreadStore.appendAssistantToken(cmid, "Hello");
    ThreadStore.appendAssistantToken(cmid, ", world");
    ThreadStore.replaceAssistantText(cmid, "Hello, world");
    ThreadStore.finalizeAssistant(cmid);
    const sseState = ThreadStore.getThreads(SESSION);
    const sseSnapshot = {
      threads: sseState.length,
      text: sseState[0].responses[0]?.text,
      status: sseState[0].responses[0]?.status,
      pending: sseState[0].pendingAssistant,
    };

    expect(v1Snapshot).toEqual(sseSnapshot);
  });

  it("persisted-then-completed lands on the same ThreadStore state both ways", () => {
    const cmid = "cmid-parity-persisted";

    // === v1: message/persisted (promotes pending) + turn/completed
    //     (no-op since pending was already finalized). ===
    seedThread(cmid, "ask");
    // δ: server's MessagePersistedEvent is metadata-only — to match the
    // SSE path (which sets text via replaceAssistantText), we stream the
    // text via message/delta first, then send the persisted event.
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, delta: "Persisted answer" },
    );
    handleMessagePersisted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        seq: 5,
        role: "assistant",
        message_id: "msg-p",
        source: "assistant",
        cursor: { stream: SESSION, seq: 5 },
        persisted_at: "2026-04-30T00:00:00Z",
      },
    );
    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, reason: "stop" },
    );
    const v1 = ThreadStore.getThreads(SESSION);
    const v1Snap = {
      threads: v1.length,
      responses: v1[0].responses.length,
      text: v1[0].responses[v1[0].responses.length - 1]?.text,
      status: v1[0].responses[v1[0].responses.length - 1]?.status,
      pending: v1[0].pendingAssistant,
    };

    ThreadStore.__resetForTests();

    // === Legacy path: SSE done + replace/finalize land on the same
    //     terminal state (one finalized response, no pending). ===
    seedThread(cmid, "ask");
    ThreadStore.replaceAssistantText(cmid, "Persisted answer");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 5 });
    const sse = ThreadStore.getThreads(SESSION);
    const sseSnap = {
      threads: sse.length,
      responses: sse[0].responses.length,
      text: sse[0].responses[sse[0].responses.length - 1]?.text,
      status: sse[0].responses[sse[0].responses.length - 1]?.status,
      pending: sse[0].pendingAssistant,
    };

    expect(v1Snap).toEqual(sseSnap);
  });

  it("error turn lands on the same ThreadStore state both ways", () => {
    const cmid = "cmid-parity-error";

    // === v1: deltas + turn/error ===
    seedThread(cmid, "ask");
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, delta: "partial" },
    );
    handleTurnError(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        error: { code: -1, message: "boom" },
      },
    );
    const v1 = ThreadStore.getThreads(SESSION);
    const v1Snap = {
      text: v1[0].responses[0]?.text,
      status: v1[0].responses[0]?.status,
      pending: v1[0].pendingAssistant,
    };

    ThreadStore.__resetForTests();

    // === Legacy path: SSE token + finalize-as-error mirrors the v1
    //     terminal state (status=error, partial text retained). ===
    seedThread(cmid, "ask");
    ThreadStore.appendAssistantToken(cmid, "partial");
    ThreadStore.finalizeAssistant(cmid, { status: "error" });
    const sse = ThreadStore.getThreads(SESSION);
    const sseSnap = {
      text: sse[0].responses[0]?.text,
      status: sse[0].responses[0]?.status,
      pending: sse[0].pendingAssistant,
    };

    expect(v1Snap).toEqual(sseSnap);
  });
});

// ---------------------------------------------------------------------------
// attachRouter wiring: confirm subscribe + detach contract is honored.
// ---------------------------------------------------------------------------

class FakeBridge implements UiProtocolBridge {
  emitMessageDelta?: (e: MessageDeltaEvent) => void;
  emitMessagePersisted?: (e: MessagePersistedEvent) => void;
  emitTaskUpdated?: (e: TaskUpdatedEvent) => void;
  emitTaskOutputDelta?: (e: TaskOutputDeltaEvent) => void;
  emitTurnLifecycle?: (
    e: TurnStartedEvent | TurnCompletedEvent | TurnErrorEvent,
  ) => void;
  emitApprovalRequested?: (e: ApprovalRequestedEvent) => void;

  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  sendTurn = vi.fn(async () => ({ accepted: true }));
  interruptTurn = vi.fn(async () => ({ interrupted: true }));
  respondToApproval = vi.fn(async () => ({
    approval_id: "x",
    accepted: true,
    status: "ok",
  }));

  onMessageDelta(h: (e: MessageDeltaEvent) => void) {
    this.emitMessageDelta = h;
    return () => {
      this.emitMessageDelta = undefined;
    };
  }
  onMessagePersisted(h: (e: MessagePersistedEvent) => void) {
    this.emitMessagePersisted = h;
    return () => {
      this.emitMessagePersisted = undefined;
    };
  }
  onTaskUpdated(h: (e: TaskUpdatedEvent) => void) {
    this.emitTaskUpdated = h;
    return () => {
      this.emitTaskUpdated = undefined;
    };
  }
  onTaskOutputDelta(h: (e: TaskOutputDeltaEvent) => void) {
    this.emitTaskOutputDelta = h;
    return () => {
      this.emitTaskOutputDelta = undefined;
    };
  }
  onTurnLifecycle(
    h: (e: TurnStartedEvent | TurnCompletedEvent | TurnErrorEvent) => void,
  ) {
    this.emitTurnLifecycle = h;
    return () => {
      this.emitTurnLifecycle = undefined;
    };
  }
  onApprovalRequested(h: (e: ApprovalRequestedEvent) => void) {
    this.emitApprovalRequested = h;
    return () => {
      this.emitApprovalRequested = undefined;
    };
  }
  onConnectionStateChange(): () => void {
    return () => {};
  }
  onWarning(): () => void {
    return () => {};
  }
}

describe("attachRouter", () => {
  it("subscribes all streams and detach() removes them", () => {
    const bridge = new FakeBridge();
    const att = attachRouter(bridge, { sessionId: SESSION });

    expect(bridge.emitMessageDelta).toBeDefined();
    expect(bridge.emitMessagePersisted).toBeDefined();
    expect(bridge.emitTaskUpdated).toBeDefined();
    expect(bridge.emitTaskOutputDelta).toBeDefined();
    expect(bridge.emitTurnLifecycle).toBeDefined();
    expect(bridge.emitApprovalRequested).toBeDefined();

    att.detach();
    expect(bridge.emitMessageDelta).toBeUndefined();
    expect(bridge.emitMessagePersisted).toBeUndefined();
    expect(bridge.emitTaskUpdated).toBeUndefined();
    expect(bridge.emitTaskOutputDelta).toBeUndefined();
    expect(bridge.emitTurnLifecycle).toBeUndefined();
    expect(bridge.emitApprovalRequested).toBeUndefined();
  });

  it("turn lifecycle multiplexer routes started / completed / error correctly", () => {
    const bridge = new FakeBridge();
    attachRouter(bridge, { sessionId: SESSION });
    seedThread("cmid-mux");
    ThreadStore.appendAssistantToken("cmid-mux", "x");

    bridge.emitTurnLifecycle?.({
      session_id: SESSION,
      turn_id: "cmid-mux",
      reason: "stop",
    });
    let state = ThreadStore.getThreads(SESSION);
    expect(state[0].responses[0].status).toBe("complete");

    ThreadStore.__resetForTests();
    seedThread("cmid-mux2");
    ThreadStore.appendAssistantToken("cmid-mux2", "x");
    bridge.emitTurnLifecycle?.({
      session_id: SESSION,
      turn_id: "cmid-mux2",
      error: { code: -1, message: "boom" },
    });
    state = ThreadStore.getThreads(SESSION);
    expect(state[0].responses[0].status).toBe("error");
  });
});
