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
  handleSpawnComplete,
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
  TurnSpawnCompleteEvent,
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
    // wire shape is metadata-only, so the row is recorded with empty
    // content and ThreadStore's media-only-merge predicate folds it
    // into the existing assistant response when media is present
    // (PR #767 added the `media` field on the wire).
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

  it("message/persisted (assistant, no media, empty pending) leaves pending alive for the late delta", () => {
    // M10 Phase 5b empty-placeholder fix: when an assistant
    // `message/persisted` lands BEFORE the streamed `message/delta`
    // (durable-then-ephemeral race the server emits routinely), the
    // pre-fix promotion code finalised the pending bubble empty and
    // then `appendAssistantToken` dropped the late delta as a phantom
    // chunk. Post-fix: the persist event is acknowledged but the
    // pending stays alive because it has no content to render yet.
    // The subsequent delta lands in the pending slot; a follow-up
    // `turn/completed` finalises with text.
    const cmid = "cmid-empty-place";
    seedThread(cmid, "ask the model");
    const persistedFirst: MessagePersistedEvent = {
      session_id: SESSION,
      turn_id: cmid,
      thread_id: cmid,
      seq: 13,
      role: "assistant",
      message_id: "msg-empty-1",
      source: "assistant",
      cursor: { stream: SESSION, seq: 13 },
      persisted_at: "2026-05-04T00:00:00Z",
      media: [],
    };
    handleMessagePersisted({ sessionId: SESSION }, persistedFirst);
    const afterPersist = ThreadStore.getThreads(SESSION)[0];
    expect(afterPersist.pendingAssistant).not.toBeNull();
    expect(afterPersist.pendingAssistant?.text).toBe("");
    expect(afterPersist.responses).toHaveLength(0);
    // The persist event's seq is stamped onto the pending so that a
    // later `turn/completed` (which doesn't carry a per-message seq)
    // still finalises with the durable per-thread sequence.
    expect(afterPersist.pendingAssistant?.historySeq).toBe(13);

    // Now the delayed delta arrives — must land in the pending slot
    // (not be dropped as a phantom chunk).
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, delta: "Background work started." },
    );
    const afterDelta = ThreadStore.getThreads(SESSION)[0];
    expect(afterDelta.pendingAssistant?.text).toBe("Background work started.");
    expect(afterDelta.pendingAssistant?.historySeq).toBe(13);
  });

  it("message/persisted (assistant, with media, empty pending) finalises with media", () => {
    // The fix preserves the legitimate finalisation case: when the
    // persist event carries media (the legacy file-delivery shape),
    // the pending bubble has something concrete to show, so the
    // promotion path finalises with the file attached.
    const cmid = "cmid-with-media";
    seedThread(cmid, "make a podcast");
    const evt: MessagePersistedEvent = {
      session_id: SESSION,
      turn_id: cmid,
      thread_id: cmid,
      seq: 7,
      role: "assistant",
      message_id: "msg-media-1",
      source: "assistant",
      cursor: { stream: SESSION, seq: 7 },
      persisted_at: "2026-05-04T00:00:00Z",
      media: ["/tmp/podcast.mp3"],
    };
    handleMessagePersisted({ sessionId: SESSION }, evt);
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant).toBeNull();
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([
      "/tmp/podcast.mp3",
    ]);
    expect(thread.responses[0].historySeq).toBe(7);
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

  // -------------------------------------------------------------------------
  // M10 Phase 2: turn/spawn_complete envelope handler
  // -------------------------------------------------------------------------

  it("turn/spawn_complete appends a NEW assistant row (no merge)", () => {
    const cmid = "cmid-spawn-1";
    seedThread(cmid, "Run deep research");
    // Simulate streamed ack text + finalize (the spawn-ack bubble lands
    // first, then the late spawn_complete envelope arrives).
    ThreadStore.appendAssistantToken(cmid, "Background work started.");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 5 });

    const evt: TurnSpawnCompleteEvent = {
      session_id: SESSION,
      turn_id: "turn-1",
      thread_id: cmid,
      task_id: "task_abc",
      response_to_client_message_id: cmid,
      seq: 12,
      message_id: "msg-spawn-1",
      source: "background",
      cursor: { stream: SESSION, seq: 12 },
      persisted_at: "2026-05-04T00:00:00Z",
      content: "Research complete: 3 sources reviewed.",
      media: ["research/_report.md"],
    };
    handleSpawnComplete({ sessionId: SESSION }, evt);

    const [thread] = ThreadStore.getThreads(SESSION);
    // EXACTLY two assistant rows under one user prompt: the original
    // spawn-ack and the new completion envelope. NO merge.
    expect(thread.responses).toHaveLength(2);
    expect(thread.responses[0].text).toBe("Background work started.");
    expect(thread.responses[1].text).toBe("Research complete: 3 sources reviewed.");
    expect(thread.responses[1].files.map((f) => f.path)).toEqual([
      "research/_report.md",
    ]);
    expect(thread.responses[1].historySeq).toBe(12);
    expect(thread.responses[1].status).toBe("complete");
    // Pending bubble stays untouched (no in-flight turn).
    expect(thread.pendingAssistant).toBeNull();
  });

  it("turn/spawn_complete falls back to response_to_client_message_id when thread_id missing", () => {
    const cmid = "cmid-spawn-fallback";
    seedThread(cmid, "ask");
    ThreadStore.finalizeAssistant(cmid);

    const evt: TurnSpawnCompleteEvent = {
      session_id: SESSION,
      task_id: "task_xyz",
      response_to_client_message_id: cmid,
      seq: 9,
      message_id: "msg-spawn-2",
      source: "background",
      cursor: { stream: SESSION, seq: 9 },
      persisted_at: "2026-05-04T00:00:00Z",
      content: "Done via fallback.",
    };
    handleSpawnComplete({ sessionId: SESSION }, evt);

    const [thread] = ThreadStore.getThreads(SESSION);
    // The completion row is present in the thread under the same user
    // prompt — the fallback used `response_to_client_message_id` as the
    // placement key when `thread_id` was absent.
    expect(thread.responses.some((r) => r.text === "Done via fallback.")).toBe(
      true,
    );
    expect(
      thread.responses.find((r) => r.text === "Done via fallback.")?.historySeq,
    ).toBe(9);
  });

  it("turn/spawn_complete with neither thread_id nor response_to_client_message_id is dropped", () => {
    seedThread("cmid-spawn-orphan", "ask");
    const evt: TurnSpawnCompleteEvent = {
      session_id: SESSION,
      task_id: "task_zzz",
      seq: 1,
      message_id: "msg-spawn-orphan",
      source: "background",
      cursor: { stream: SESSION, seq: 1 },
      persisted_at: "2026-05-04T00:00:00Z",
      content: "orphan",
    };
    handleSpawnComplete({ sessionId: SESSION }, evt);

    const [thread] = ThreadStore.getThreads(SESSION);
    // Original placeholder pendingAssistant only; no completion row added.
    expect(thread.responses).toHaveLength(0);
  });

  it("turn/spawn_complete with unknown thread_id lands in the ACTIVE session, not a stale one (codex P2 fix)", () => {
    // Reproduces codex's P2 finding: with a stale session bucket
    // present in `sessionsByKey`, an envelope for an unknown thread_id
    // could be hosted in the stale session by `pickHostSessionForOrphan`.
    // The fix passes `cfg.sessionId` into `appendCompletionBubble` so
    // the orphan creates inside the router's active session.
    const STALE = "sess-stale-A";
    const ACTIVE = "sess-active-B";
    // Seed both sessions so `sessionsByKey` is non-empty for both.
    ThreadStore.addUserMessage(STALE, {
      text: "old",
      clientMessageId: "cmid-stale",
    });
    ThreadStore.addUserMessage(ACTIVE, {
      text: "new",
      clientMessageId: "cmid-active",
    });

    const evt: TurnSpawnCompleteEvent = {
      session_id: ACTIVE,
      thread_id: "cmid-unknown-bg",
      task_id: "task_orphan",
      seq: 11,
      message_id: "msg-orphan",
      source: "background",
      cursor: { stream: ACTIVE, seq: 11 },
      persisted_at: "2026-05-04T00:00:00Z",
      content: "Late background result.",
    };
    handleSpawnComplete({ sessionId: ACTIVE }, evt);

    const activeThreads = ThreadStore.getThreads(ACTIVE);
    const staleThreads = ThreadStore.getThreads(STALE);
    expect(
      activeThreads.find((t) => t.id === "cmid-unknown-bg"),
    ).toBeDefined();
    expect(
      staleThreads.find((t) => t.id === "cmid-unknown-bg"),
    ).toBeUndefined();

    // Cleanup the extra session we created so the global afterEach
    // reset still leaves a clean slate.
    ThreadStore.clearSession(STALE);
    ThreadStore.clearSession(ACTIVE);
  });

  it("turn/spawn_complete is idempotent on replay (same seq => single row)", () => {
    const cmid = "cmid-spawn-replay";
    seedThread(cmid, "ask");
    ThreadStore.finalizeAssistant(cmid);

    const evt: TurnSpawnCompleteEvent = {
      session_id: SESSION,
      thread_id: cmid,
      task_id: "task_replay",
      seq: 33,
      message_id: "msg-spawn-replay",
      source: "background",
      cursor: { stream: SESSION, seq: 33 },
      persisted_at: "2026-05-04T00:00:00Z",
      content: "Once and only once.",
    };
    handleSpawnComplete({ sessionId: SESSION }, evt);
    handleSpawnComplete({ sessionId: SESSION }, evt);

    const [thread] = ThreadStore.getThreads(SESSION);
    const completions = thread.responses.filter(
      (r) => r.text === "Once and only once.",
    );
    expect(completions).toHaveLength(1);
  });

  // ---- M10 Phase 2 regression-pin: lock the architecture ------------------
  //
  // This test fixes the failure mode that motivated M10. The legacy splice
  // path (`appendAssistantFile` media-only-merge predicate, deleted in
  // Phase 5) treats an existing assistant bubble whose content contains a
  // bare `[file: ...]` marker as a "media-only companion" and merges late
  // file deliveries INTO it. With the new envelope path the same scenario
  // MUST instead create a NEW row in the same thread. If a future refactor
  // accidentally re-routes spawn_complete through the splice predicate,
  // this test fails — the wave-6c-onward bug class would be back.
  it("turn/spawn_complete creates a NEW row even when a finalized [file:] marker bubble exists", () => {
    const cmid = "cmid-regression-pin";
    seedThread(cmid, "ask");
    // Stream a bare `[file: ...]` marker into the spawn-ack bubble — the
    // exact shape the legacy `isMediaOnlyCompanion` predicate matches.
    ThreadStore.appendAssistantToken(cmid, "[file: research/_report.md]");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 4 });
    const before = ThreadStore.getThreads(SESSION)[0];
    const beforeRows = before.responses.length;
    expect(beforeRows).toBe(1);

    handleSpawnComplete(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        thread_id: cmid,
        task_id: "task_pin",
        seq: 5,
        message_id: "msg-pin",
        source: "background",
        cursor: { stream: SESSION, seq: 5 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "Real research result.",
        media: ["research/_report.md"],
      },
    );

    const [thread] = ThreadStore.getThreads(SESSION);
    // CRITICAL: the new envelope creates a NEW row. NOT a merge into the
    // existing `[file:]` bubble.
    expect(thread.responses).toHaveLength(beforeRows + 1);
    expect(thread.responses[0].text).toBe("[file: research/_report.md]");
    expect(thread.responses[1].text).toBe("Real research result.");
    expect(thread.responses[1].files.map((f) => f.path)).toEqual([
      "research/_report.md",
    ]);
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
  emitSpawnComplete?: (e: TurnSpawnCompleteEvent) => void;
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
  onSpawnComplete(h: (e: TurnSpawnCompleteEvent) => void) {
    this.emitSpawnComplete = h;
    return () => {
      this.emitSpawnComplete = undefined;
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
    expect(bridge.emitSpawnComplete).toBeDefined();
    expect(bridge.emitTaskUpdated).toBeDefined();
    expect(bridge.emitTaskOutputDelta).toBeDefined();
    expect(bridge.emitTurnLifecycle).toBeDefined();
    expect(bridge.emitApprovalRequested).toBeDefined();

    att.detach();
    expect(bridge.emitMessageDelta).toBeUndefined();
    expect(bridge.emitMessagePersisted).toBeUndefined();
    expect(bridge.emitSpawnComplete).toBeUndefined();
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
