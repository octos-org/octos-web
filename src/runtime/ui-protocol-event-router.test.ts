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
  __resetTurnMetaForTest,
  attachRouter,
  handleApprovalRequested,
  handleFileAttached,
  handleMessageDelta,
  handleMessagePersisted,
  handleProgressUpdated,
  handleQueueState,
  handleRouterFailover,
  handleRouterStatus,
  handleSpawnComplete,
  handleTaskOutputDelta,
  handleTaskUpdated,
  handleToolCompleted,
  handleToolProgress,
  handleToolStarted,
  handleTurnCompleted,
  handleTurnError,
  handleTurnStarted,
} from "./ui-protocol-event-router";
import type {
  ApprovalRequestedEvent,
  FileAttachedEvent,
  MessageDeltaEvent,
  MessagePersistedEvent,
  ProgressUpdatedEvent,
  QueueStateEvent,
  RouterFailoverEvent,
  RouterStatusEvent,
  TaskOutputDeltaEvent,
  TaskUpdatedEvent,
  ToolCompletedEvent,
  ToolProgressEvent,
  ToolStartedEvent,
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
  __resetTurnMetaForTest();
});

describe("router event mapping", () => {
  it("message/delta appends to the assistant pending slot", () => {
    seedThread("cmid-1");
    const evt: MessageDeltaEvent = {
      session_id: SESSION,
      turn_id: "cmid-1",
      text: "Hello",
    };
    handleMessageDelta({ sessionId: SESSION }, evt);
    handleMessageDelta(
      { sessionId: SESSION },
      { ...evt, text: ", world" },
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

  it("message/persisted with wire `content` surfaces summary alongside media on the late-artifact path", () => {
    // 2026-05-19 fix: server now carries the persisted row's `content`
    // on the wire (omitted when empty) so captions / summaries that
    // accompany a `send_file` / mofa_slides / fm_tts delivery reach the
    // chat bubble. Pre-fix the SPA hardcoded `content: ""` here, so the
    // file rendered but the summary text vanished — "file were
    // delivered, what was missing is the summary in chat".
    //
    // Expectation: a late-artifact `message/persisted` with both
    // `content` and `media` lands as a row whose text == event.content
    // and whose files == event.media. The row is NOT detected as a
    // media-only companion (because content is non-empty), so it
    // renders as its own bubble with text + file together.
    const evt: MessagePersistedEvent = {
      session_id: SESSION,
      turn_id: "cmid-summary",
      thread_id: "cmid-summary",
      seq: 18,
      role: "assistant",
      message_id: "msg-summary",
      source: "background",
      cursor: { stream: SESSION, seq: 18 },
      persisted_at: "2026-05-19T00:00:00Z",
      media: ["slides/deck-1779207239/output/deck.pptx"],
      content: "Generated 12 slides — Intel 2026 stock outlook deck is ready.",
    };
    handleMessagePersisted({ sessionId: SESSION }, evt);
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread).toBeDefined();
    const row = thread.responses[thread.responses.length - 1];
    expect(row).toBeDefined();
    expect(row.text).toBe(
      "Generated 12 slides — Intel 2026 stock outlook deck is ready.",
    );
    expect(row.files.map((f) => f.path)).toEqual([
      "slides/deck-1779207239/output/deck.pptx",
    ]);
  });

  it("multi-iter assistant row with wire content lands as its own bubble after first iter finalised", () => {
    // 2026-05-19 codex MAJOR fix: pre-fix the phantom-bubble defence
    // dropped EVERY no-media assistant `message/persisted`, including
    // iter-2+ rows whose text was no longer being streamed (the
    // pending bubble was finalised by iter-1's persist and the
    // `isFinalizedAndIdle` guard drops late `appendAssistantToken`).
    // That LOST iter-2+ text entirely. Post-fix: dropping is gated on
    // BOTH content AND media being empty, so a content-bearing iter-2
    // row falls through to `appendPersistedMessage` and lands as a
    // separate bubble. ThreadStore's seq-based idempotency prevents
    // duplicate rendering on replay.
    const cmid = "cmid-multi-iter";
    seedThread(cmid, "ask multi");

    // Iter 1: delta-streamed text + persist finalises the bubble.
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, text: "Iter 1 text." },
    );
    handleMessagePersisted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        seq: 30,
        role: "assistant",
        message_id: "msg-iter1",
        source: "assistant",
        cursor: { stream: SESSION, seq: 30 },
        persisted_at: "2026-05-19T00:00:00Z",
        content: "Iter 1 text.",
      },
    );

    // Iter 2: arrives after the pending was finalised. Carries only
    // wire `content` (no media, no streamed delta). Pre-fix this row
    // was dropped by the phantom-bubble defence; post-fix it lands as
    // a new bubble.
    handleMessagePersisted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        seq: 31,
        role: "assistant",
        message_id: "msg-iter2",
        source: "assistant",
        cursor: { stream: SESSION, seq: 31 },
        persisted_at: "2026-05-19T00:00:01Z",
        content: "Iter 2 final answer.",
      },
    );

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(2);
    expect(thread.responses[0].text).toBe("Iter 1 text.");
    expect(thread.responses[1].text).toBe("Iter 2 final answer.");
    expect(thread.responses[1].historySeq).toBe(31);
  });

  it("tryPromote falls back to wire content when streamed delta never arrived", () => {
    // 2026-05-19 codex MAJOR fix: when the server emits `content` on
    // the wire but the streamed `message/delta` never arrives (or
    // arrives after persist), pre-fix the bubble was finalised empty.
    // Post-fix: tryPromote appends `event.content` as the bubble's
    // text before finalising, so the user sees real content.
    const cmid = "cmid-delta-skipped";
    seedThread(cmid, "ask");
    // No `handleMessageDelta` — simulate the race where persist wins.
    handleMessagePersisted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        seq: 50,
        role: "assistant",
        message_id: "msg-no-delta",
        source: "assistant",
        cursor: { stream: SESSION, seq: 50 },
        persisted_at: "2026-05-19T00:00:00Z",
        content: "Wire content stood in for the missing delta.",
      },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant).toBeNull(); // finalised
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe(
      "Wire content stood in for the missing delta.",
    );
    expect(thread.responses[0].historySeq).toBe(50);
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
      { session_id: SESSION, turn_id: cmid, text: "Background work started." },
    );
    const afterDelta = ThreadStore.getThreads(SESSION)[0];
    expect(afterDelta.pendingAssistant?.text).toBe("Background work started.");
    expect(afterDelta.pendingAssistant?.historySeq).toBe(13);
  });

  it("message/persisted replayed after delta+completed produces NO duplicate bubble", () => {
    // Codex Phase 5b P1: assert the empty-placeholder defence is
    // idempotent on replay. Sequence: persisted (no media) -> delta ->
    // completed -> SAME persisted (server replay on cursor reconnect).
    // Pre-fix the stamped seq was lost; a replayed persist could fall
    // through to `appendPersistedMessage` and append a blank duplicate
    // row beside the finalised bubble. With `stampPendingHistorySeq`
    // the seq lands on the pending and propagates to the finalised
    // row; replay then matches the same `historySeq` in the thread's
    // responses and is dropped at the idempotency check.
    const cmid = "cmid-replay";
    seedThread(cmid, "ask once");
    const persisted: MessagePersistedEvent = {
      session_id: SESSION,
      turn_id: cmid,
      thread_id: cmid,
      seq: 21,
      role: "assistant",
      message_id: "msg-replay-1",
      source: "assistant",
      cursor: { stream: SESSION, seq: 21 },
      persisted_at: "2026-05-04T00:00:00Z",
      media: [],
    };
    handleMessagePersisted({ sessionId: SESSION }, persisted);
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, text: "Hello there." },
    );
    // Simulate `turn/completed` finalising without a per-message seq —
    // the stamped pending seq must propagate onto the finalised row.
    ThreadStore.finalizeAssistant(cmid);
    let [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Hello there.");
    expect(thread.responses[0].historySeq).toBe(21);

    // Server replays the same persisted event (e.g. WS reconnect with
    // cursor before seq 21).
    handleMessagePersisted({ sessionId: SESSION }, persisted);
    [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Hello there.");
    expect(thread.responses[0].historySeq).toBe(21);
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
    // Codex round-2: spawn_only running state also fans out into the
    // spinner indicator. The dispatch is NOT terminal (still running).
    const progressEvt = dispatched.find(
      (e) => e.type === "crew:tool_progress",
    ) as CustomEvent | undefined;
    expect(progressEvt).toBeDefined();
    expect(progressEvt!.detail.tool).toBe("task-7"); // no tool name cached
    expect(progressEvt!.detail.message).toBe("deep_research");
    expect(progressEvt!.detail.turnId).toBe("cmid-3");
    expect(progressEvt!.detail.terminal).toBeUndefined();
  });

  it("task/updated completed fans out a terminal crew:tool_progress (spawn_only spinner clear)", () => {
    // Spawn_only tools (podcast_generate, fm_tts, deep_search,
    // mofa_slides) emit their lifecycle exclusively through
    // `task/updated`. The lifted `ToolProgressIndicator` needs an
    // explicit terminal signal because the LLM `crew:thinking false`
    // already fired at the enclosing `turn/completed` long before the
    // background task finished.
    seedThread("cmid-spawnonly");
    const dispatched: Event[] = [];
    const cfg = {
      sessionId: SESSION,
      dispatchEvent: (e: Event) => dispatched.push(e),
    };
    handleTaskUpdated(cfg, {
      session_id: SESSION,
      turn_id: "cmid-spawnonly",
      task_id: "task-podcast",
      state: "running",
      title: "synthesising 1/3",
    });
    handleTaskUpdated(cfg, {
      session_id: SESSION,
      turn_id: "cmid-spawnonly",
      task_id: "task-podcast",
      state: "completed",
    });
    const terminalEvt = dispatched
      .filter((e) => e.type === "crew:tool_progress")
      .map((e) => e as CustomEvent)
      .find((e) => e.detail.terminal === true);
    expect(terminalEvt).toBeDefined();
    expect(terminalEvt!.detail.turnId).toBe("cmid-spawnonly");
    expect(terminalEvt!.detail.message).toBe("done");
  });

  it("task/updated running passes through new labels (state-only dedupe would suppress spinner refresh)", () => {
    // Codex round-3: a stream of `running` updates with refreshed
    // `title`/`runtime_detail` values must reach the lifted spinner.
    // Pre-fix the by-state-only dedupe dropped them after the first,
    // so spawn_only progress was stuck on the very first label.
    seedThread("cmid-relabel");
    const dispatched: Event[] = [];
    const cfg = {
      sessionId: SESSION,
      dispatchEvent: (e: Event) => dispatched.push(e),
    };
    handleTaskUpdated(cfg, {
      session_id: SESSION,
      turn_id: "cmid-relabel",
      task_id: "task-relabel",
      state: "running",
      title: "synthesising 1/3",
    });
    handleTaskUpdated(cfg, {
      session_id: SESSION,
      turn_id: "cmid-relabel",
      task_id: "task-relabel",
      state: "running",
      title: "synthesising 2/3",
    });
    handleTaskUpdated(cfg, {
      session_id: SESSION,
      turn_id: "cmid-relabel",
      task_id: "task-relabel",
      state: "running",
      title: "synthesising 3/3",
    });
    const progressFrames = dispatched
      .filter((e) => e.type === "crew:tool_progress")
      .map((e) => (e as CustomEvent).detail.message);
    expect(progressFrames).toEqual([
      "synthesising 1/3",
      "synthesising 2/3",
      "synthesising 3/3",
    ]);
  });

  it("task/output/delta fans out into crew:tool_progress (live spawn_only stdout)", () => {
    // Codex round-3: spawn_only tools that emit progress as stdout
    // chunks (rather than `task/updated` titles) must also light the
    // spinner. Non-terminal — completion is signalled by
    // `task/updated` completed/failed/errored.
    seedThread("cmid-stdout");
    const dispatched: Event[] = [];
    const cfg = {
      sessionId: SESSION,
      dispatchEvent: (e: Event) => dispatched.push(e),
    };
    handleTaskOutputDelta(cfg, {
      session_id: SESSION,
      turn_id: "cmid-stdout",
      task_id: "task-stdout",
      chunk: "processing chunk 5/10",
    });
    const progressEvt = dispatched.find(
      (e) => e.type === "crew:tool_progress",
    ) as CustomEvent | undefined;
    expect(progressEvt).toBeDefined();
    expect(progressEvt!.detail.message).toBe("processing chunk 5/10");
    expect(progressEvt!.detail.terminal).toBeUndefined();
  });

  it("task/updated failed fans out a terminal crew:tool_progress with error message", () => {
    seedThread("cmid-spawnerr");
    const dispatched: Event[] = [];
    const cfg = {
      sessionId: SESSION,
      dispatchEvent: (e: Event) => dispatched.push(e),
    };
    handleTaskUpdated(cfg, {
      session_id: SESSION,
      turn_id: "cmid-spawnerr",
      task_id: "task-fail",
      state: "running",
    });
    handleTaskUpdated(cfg, {
      session_id: SESSION,
      turn_id: "cmid-spawnerr",
      task_id: "task-fail",
      state: "failed",
    });
    const terminalEvt = dispatched
      .filter((e) => e.type === "crew:tool_progress")
      .map((e) => e as CustomEvent)
      .find((e) => e.detail.terminal === true);
    expect(terminalEvt).toBeDefined();
    expect(terminalEvt!.detail.message).toBe("error");
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

  // -------------------------------------------------------------------------
  // Sidebar spinner — live `task/updated` must hydrate TaskStore directly
  // -------------------------------------------------------------------------
  //
  // The sidebar session-row spinner (`useAllTasksBySession()` in
  // `chat-thread.tsx`) gates on TaskStore having at least one
  // `spawned`/`running` row for the session. Pre-fix the router's
  // `handleTaskUpdated` only mutated ThreadStore + dispatched
  // `crew:bg_tasks` (which arms the 2.5 s task-watcher poll) — it never
  // mutated TaskStore. The poll itself is currently broken upstream by a
  // session_key filter mismatch on the server's `/api/sessions/.../tasks`
  // path (see `task_supervisor.rs:1753-1758`: the WS-side `snapshot_excluding`
  // path clears the supervisor's `session_key`, so the endpoint returns
  // `[]` for the very tasks the running session has). So the sidebar
  // spinner stayed cold for spawn_only tasks even though the wire path
  // was working.
  //
  // Fix: hydrate TaskStore directly from the live `task/updated` envelope
  // (and from the terminal `turn/spawn_complete` belt-and-braces) so the
  // sidebar spinner fires regardless of poll state.
  it("handleTaskUpdated state=\"running\" hydrates TaskStore for the sidebar spinner", async () => {
    const TaskStore = await import("@/store/task-store");
    TaskStore.clearTasks(SESSION);
    seedThread("cmid-sidebar-run");
    handleTaskUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-sidebar-run",
        task_id: "task-sidebar-running",
        tool_call_id: "tc-sidebar-running",
        state: "running",
        title: "deep_search",
      },
    );
    const tasks = TaskStore.getTasks(SESSION);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task-sidebar-running");
    expect(tasks[0].status).toBe("running");
    expect(tasks[0].tool_call_id).toBe("tc-sidebar-running");
    expect(tasks[0].tool_name).toBe("deep_search");
    TaskStore.clearTasks(SESSION);
  });

  it("handleTaskUpdated state=\"completed\" flips the TaskStore row to completed", async () => {
    const TaskStore = await import("@/store/task-store");
    TaskStore.clearTasks(SESSION);
    seedThread("cmid-sidebar-done");
    handleTaskUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-sidebar-done",
        task_id: "task-sidebar-done",
        tool_call_id: "tc-sidebar-done",
        state: "running",
        title: "podcast_generate",
      },
    );
    expect(TaskStore.getTasks(SESSION)[0]?.status).toBe("running");
    handleTaskUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-sidebar-done",
        task_id: "task-sidebar-done",
        tool_call_id: "tc-sidebar-done",
        state: "completed",
      },
    );
    const tasks = TaskStore.getTasks(SESSION);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("completed");
    expect(tasks[0].completed_at).toBeTruthy();
    TaskStore.clearTasks(SESSION);
  });

  it("handleSpawnComplete merges a completed TaskStore row even when TaskStore is empty (defence-in-depth)", async () => {
    // Regression check: the helper must run unconditionally — gating on
    // a pre-existing row would leave the sidebar stuck if the
    // `task/updated state="running"` envelope was missed or arrived
    // after `turn/spawn_complete` due to reorder/replay.
    const TaskStore = await import("@/store/task-store");
    TaskStore.clearTasks(SESSION);
    const cmid = "cmid-sidebar-spawn-only";
    seedThread(cmid, "Generate a podcast");
    ThreadStore.appendAssistantToken(cmid, "Background work started.");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 5 });
    handleSpawnComplete(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        task_id: "task-sidebar-spawn-only",
        tool_call_id: "tc-sidebar-spawn-only",
        response_to_client_message_id: cmid,
        seq: 17,
        message_id: "msg-sidebar-spawn-only",
        source: "background",
        cursor: { stream: SESSION, seq: 17 },
        persisted_at: "2026-05-15T00:00:00Z",
        content: "Podcast generated.",
      },
    );
    const tasks = TaskStore.getTasks(SESSION);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task-sidebar-spawn-only");
    expect(tasks[0].status).toBe("completed");
    expect(tasks[0].tool_call_id).toBe("tc-sidebar-spawn-only");
    TaskStore.clearTasks(SESSION);
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
    // the routing lands inside the router's active session.
    //
    // Bug 2026-05-14 follow-up: when the active session has an existing
    // user-rooted thread, the completion is attributed to that thread
    // instead of minting a brand-new orphan with an empty user
    // placeholder. The placement-into-active-session invariant the
    // codex P2 fix protects is still upheld here: the completion's
    // body MUST appear in the active session's threads (and MUST NOT
    // appear in the stale session's threads). What changes is the
    // host thread identity — we attribute to the existing
    // `cmid-active` thread rather than a freshly-minted
    // `cmid-unknown-bg` orphan with an empty user bubble.
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
    // The completion's content must be visible in the ACTIVE session
    // (the codex P2 invariant) — attributed to the existing
    // `cmid-active` thread rather than a brand-new orphan.
    const activeHost = activeThreads.find((t) => t.id === "cmid-active");
    expect(activeHost).toBeDefined();
    expect(
      activeHost!.responses.some((r) =>
        r.text.includes("Late background result"),
      ),
    ).toBe(true);
    // The completion's content must NOT have leaked into the stale
    // session.
    for (const t of staleThreads) {
      expect(
        t.responses.some((r) => r.text.includes("Late background result")),
      ).toBe(false);
    }

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

  // -------------------------------------------------------------------------
  // dspfac "two bubbles per turn" — server-side suppression of the
  // synthesised spawn_only ack (server PR: `fix(api): suppress
  // synthesized spawn_only ack bubble via Background source override`).
  // -------------------------------------------------------------------------
  //
  // Bug shape: an iter-1 spawn_only turn (the LLM picks `run_pipeline`,
  // emits a preamble TEXT + `tool_calls`, then stops) used to commit
  // TWO assistant `message/persisted` envelopes:
  //
  //   1. The iter-1 LLM reply (assistant role, preamble TEXT + tool_calls,
  //      `source: assistant`) — "Bubble with details" (preamble + tool card).
  //   2. The synthesised ack the agent loop fabricates
  //      ("Background work started for `run_pipeline`. The final result
  //      will be delivered automatically when it is ready.",
  //      `source: assistant`) — "Bubble without details" (text only).
  //
  // Both reached the SPA as assistant rows, so the chat shape was TWO
  // adjacent bubbles per turn.
  //
  // Server fix tags the synthesised ack row with
  // `MessagePersistedSource::Background`. The existing capability filter
  // at `crates/octos-cli/src/api/ui_protocol.rs::live_event_passes_capability_filter`
  // (line ~7600) then SUPPRESSES that row for SPAs that negotiated
  // `event.spawn_complete.v1` (today's SPA always does). Legacy clients
  // without that capability continue to receive the ack — backward-compatible.
  //
  // SPA-observable wire shape for upgraded clients (today's SPA):
  //
  //   delta(preamble) → persisted(preamble, source=assistant) →
  //                                                turn/completed
  //
  // The persisted ack envelope NEVER reaches the SPA (server-suppressed),
  // so the thread settles with EXACTLY ONE assistant response.
  it(
    "spawn_only turn collapses to ONE bubble when server suppresses the synthesised ack (dspfac fix)",
    () => {
      const cmid = "cmid-spawn-only-collapse";
      seedThread(cmid, "Please run the pipeline.");

      // Stream the iter-1 preamble TEXT (the LLM's reply that drove the
      // spawn_only branch).
      const preambleText = "Sure, I'll kick off the pipeline now.";
      handleMessageDelta(
        { sessionId: SESSION },
        { session_id: SESSION, turn_id: cmid, text: preambleText },
      );

      // Persist the iter-1 row: `source: assistant` (role-derived
      // default — this is `response.messages[0]` in the agent loop,
      // NOT the synthesised ack).
      handleMessagePersisted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          thread_id: cmid,
          seq: 40,
          role: "assistant",
          message_id: "msg-preamble",
          source: "assistant",
          cursor: { stream: SESSION, seq: 40 },
          persisted_at: "2026-05-22T00:00:00Z",
          content: preambleText,
        },
      );

      // The synthesised ack `message/persisted` (with
      // `source: background`) is SERVER-SUPPRESSED for clients that
      // negotiated `event.spawn_complete.v1` — i.e. it is NEVER
      // dispatched into the router. Today's SPA always negotiates the
      // capability, so the realistic wire sequence skips that frame.

      // Turn finalises.
      handleTurnCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          reason: "stop",
        },
      );

      const [thread] = ThreadStore.getThreads(SESSION);
      expect(thread.pendingAssistant).toBeNull();
      // Single-bubble assertion — pre-fix this was 2 (the duplicate
      // synthesised ack rendered as its own bubble).
      expect(thread.responses).toHaveLength(1);
      expect(thread.responses[0].text).toBe(preambleText);
      expect(thread.responses[0].historySeq).toBe(40);
    },
  );

  // -------------------------------------------------------------------------
  // Stuck-spinner-after-spawn_only-completion bug — codex independent diagnosis
  // -------------------------------------------------------------------------
  //
  // Pre-fix gap: `handleSpawnComplete` (the terminal `turn/spawn_complete`
  // signal for spawn_only background completion) appended the completion
  // bubble and dropped the `toolNameByCallId` cache, but it NEVER called
  // `ThreadStore.setToolCallStatus(toolCallId, "complete")`. So the
  // originating `addToolCall(...)` left the tool card stuck at
  // `status: "running"` after the work finished, and every spinner / icon
  // gated on `toolCall.status === "running"` (`ToolProgressIndicator`,
  // `ToolCallBubble` per-tool icon, streaming-dots placeholder) kept
  // spinning. The four cosmetic commits (586ce04, f8717fc2, 27420f1) all
  // correctly gate on `status` — this test fixes WHO updates status.
  //
  // The `turn/spawn_complete` envelope has NO `success` field (see the
  // `TurnSpawnCompleteEvent` wire struct in
  // `crates/octos-core/src/ui_protocol.rs`). The envelope is emitted ONLY
  // on successful completion; failures arrive via `task/updated`
  // `state="failed"|"errored"` which `handleTaskUpdated` already maps to
  // `setToolCallStatus(..., "error")` (test on line 436).
  it(
    "turn/spawn_complete flips the originating tool call status to complete (stuck-spinner fix)",
    () => {
      const cmid = "cmid-spawn-status";
      const taskId = "task_podcast_1";
      seedThread(cmid, "Generate a podcast about Rust async");

      // Real spawn_only flow: `turn/completed` lands FIRST (server-side
      // ack), THEN `tool/started` arrives for the long-running tool that
      // runs in the background. So we finalize before adding the tool.
      ThreadStore.appendAssistantToken(cmid, "Background work started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 5 });

      // `tool/started` lands the tool card on the finalized response
      // (via `pickAssistantSlot` fallback). Status: "running".
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: taskId,
          tool_name: "podcast_generate",
        },
      );

      // Sanity check: tool card was placed and is running.
      const beforeEvt = ThreadStore.getThreads(SESSION)[0];
      const beforeTc = beforeEvt.responses[0].toolCalls.find(
        (c) => c.id === taskId,
      );
      expect(beforeTc?.status).toBe("running");

      // Fire the terminal `turn/spawn_complete` envelope.
      const evt: TurnSpawnCompleteEvent = {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        task_id: taskId,
        response_to_client_message_id: cmid,
        seq: 17,
        message_id: "msg-spawn-status",
        source: "background",
        cursor: { stream: SESSION, seq: 17 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "✓ podcast generated (output.mp3)",
        media: ["output.mp3"],
      };
      handleSpawnComplete({ sessionId: SESSION }, evt);

      // Post-fix: the originating tool call flips to `complete`, so every
      // spinner / icon gated on `toolCall.status === "running"` clears.
      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find((c) => c.id === taskId);
      expect(tc?.status).toBe("complete");
    },
  );

  it(
    "turn/spawn_complete flips status when only response_to_client_message_id resolves the thread",
    () => {
      // Same bug, narrower placement path: when `event.turn_id` is absent
      // (older daemons) the placement key falls back to
      // `response_to_client_message_id`. The status-update path must use
      // the same fallback so the tool call still locates its host thread.
      const cmid = "cmid-spawn-status-fallback";
      const taskId = "task_deep_search_fallback";
      seedThread(cmid, "ask");
      ThreadStore.appendAssistantToken(cmid, "Started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 2 });
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: taskId,
          tool_name: "deep_search",
        },
      );

      const evt: TurnSpawnCompleteEvent = {
        session_id: SESSION,
        // turn_id intentionally omitted
        task_id: taskId,
        response_to_client_message_id: cmid,
        seq: 9,
        message_id: "msg-spawn-fb",
        source: "background",
        cursor: { stream: SESSION, seq: 9 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "Done via fallback.",
      };
      handleSpawnComplete({ sessionId: SESSION }, evt);

      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find((c) => c.id === taskId);
      expect(tc?.status).toBe("complete");
    },
  );

  // -------------------------------------------------------------------------
  // Codex final-3 gap 1: addToolCall must NOT revert terminal status to
  // "running" when a `tool/started` event replays for a settled tool call.
  // -------------------------------------------------------------------------
  //
  // Pre-fix sequence (mini5 with bundle index-CnOGu3kL.js, PR #131 only):
  //   1. tool/started → addToolCall(..., status: "running")
  //   2. background completes
  //   3. turn/spawn_complete → setToolCallStatus(..., "complete") ✓
  //   4. **replayed tool/started for same tool_call_id** → addToolCall
  //      force-set status BACK to "running"
  //   5. all in-bubble spinner gates re-activate → "tool bubble still has
  //      spinning even task is done"
  //
  // Post-fix: addToolCall preserves terminal status. Idempotent re-registration
  // is fine; reopening a settled tool call is the bug.
  it(
    "handleToolStarted replayed after handleSpawnComplete does NOT revert complete → running (codex final-3 gap 1)",
    () => {
      const cmid = "cmid-replay-revert";
      const taskId = "task_replay_revert";
      seedThread(cmid, "Generate a podcast");
      ThreadStore.appendAssistantToken(cmid, "Background work started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 3 });

      // 1. tool/started → status="running"
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: taskId,
          tool_name: "podcast_generate",
        },
      );
      expect(
        ThreadStore.getThreads(SESSION)[0].responses[0].toolCalls.find(
          (c) => c.id === taskId,
        )?.status,
      ).toBe("running");

      // 2./3. turn/spawn_complete → status="complete"
      handleSpawnComplete(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          thread_id: cmid,
          task_id: taskId,
          response_to_client_message_id: cmid,
          seq: 9,
          message_id: "msg-replay-revert",
          source: "background",
          cursor: { stream: SESSION, seq: 9 },
          persisted_at: "2026-05-15T00:00:00Z",
          content: "Podcast generated.",
        },
      );
      expect(
        ThreadStore.getThreads(SESSION)[0].responses[0].toolCalls.find(
          (c) => c.id === taskId,
        )?.status,
      ).toBe("complete");

      // 4. **Replayed `tool/started` for same id.** Pre-fix this reset
      //    status to "running"; post-fix it preserves "complete".
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: taskId,
          tool_name: "podcast_generate",
        },
      );

      // CRITICAL: the spinner gate must clear and stay cleared.
      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find((c) => c.id === taskId);
      expect(tc?.status).toBe("complete");
    },
  );

  it(
    "handleToolStarted replayed after error status does NOT revert error → running (codex final-3 gap 1)",
    () => {
      // Symmetric: terminal `error` (from task/updated failed/errored) also
      // must be preserved against a replayed tool/started.
      const cmid = "cmid-replay-error";
      const taskId = "task_replay_error";
      seedThread(cmid, "Generate a podcast");
      ThreadStore.appendAssistantToken(cmid, "Started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 2 });

      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: taskId,
          tool_name: "deep_search",
        },
      );
      // Drive an error terminal status via setToolCallStatus directly.
      ThreadStore.setToolCallStatus(cmid, taskId, "error");
      expect(
        ThreadStore.getThreads(SESSION)[0].responses[0].toolCalls.find(
          (c) => c.id === taskId,
        )?.status,
      ).toBe("error");

      // Replay tool/started → must preserve "error".
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: taskId,
          tool_name: "deep_search",
        },
      );
      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find((c) => c.id === taskId);
      expect(tc?.status).toBe("error");
    },
  );

  // -------------------------------------------------------------------------
  // Codex final-3 gap 2: setToolCallStatus full-thread fallback when
  // `pickAssistantSlot` misses.
  // -------------------------------------------------------------------------
  //
  // Real-world sequence (mini5 reproduction): tool/started lands the tool
  // card on responses[0] (the spawn-ack bubble). turn/spawn_complete
  // appends a NEW bubble at responses[1]. Now responses[1] is the most
  // recent assistant slot — `pickAssistantSlot` returns it, the tool-call
  // lookup misses, and `setToolCallStatus` no-ops. Without the
  // full-thread fallback, terminal status flips (from a replayed
  // task/updated `completed`, or a redrive of turn/spawn_complete) all
  // silently no-op, and the chip stays running forever.
  it(
    "setToolCallStatus falls back to a full-thread scan when pickAssistantSlot returns the wrong bubble (codex final-3 gap 2)",
    () => {
      const cmid = "cmid-slot-fallback";
      const toolCallId = "tc_slot_fallback";
      seedThread(cmid, "Generate a podcast");
      ThreadStore.appendAssistantToken(cmid, "Background work started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 3 });

      // tool/started lands the chip on responses[0].
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          tool_name: "podcast_generate",
        },
      );
      // Append a NEW completion bubble at responses[1]. Now responses[1]
      // is the most recent slot (the one pickAssistantSlot returns) but
      // does NOT carry the tool card.
      ThreadStore.appendCompletionBubble(cmid, {
        text: "Another response.",
        media: [],
        spawnComplete: true,
        sourceClientMessageId: cmid,
        historySeq: 12,
        messageId: "msg-extra",
        persistedAt: "2026-05-15T00:00:01Z",
        sessionId: SESSION,
      });

      // Sanity check: 2 bubbles exist, tool call is on responses[0],
      // responses[1] has no tool cards.
      const [before] = ThreadStore.getThreads(SESSION);
      expect(before.responses).toHaveLength(2);
      expect(
        before.responses[0].toolCalls.find((c) => c.id === toolCallId)
          ?.status,
      ).toBe("running");
      expect(before.responses[1].toolCalls).toHaveLength(0);

      // Now flip the tool status. With the old `pickAssistantSlot`-only
      // logic this would no-op because the picker returns responses[1]
      // (no tool call there). The full-thread fallback walks every
      // assistant slot and finds the tool card on responses[0].
      const applied = ThreadStore.setToolCallStatus(
        cmid,
        toolCallId,
        "complete",
      );
      expect(applied).toBe(true);

      const [after] = ThreadStore.getThreads(SESSION);
      const tc = after.responses[0].toolCalls.find((c) => c.id === toolCallId);
      expect(tc?.status).toBe("complete");
    },
  );

  // -------------------------------------------------------------------------
  // Codex final-3 bonus check: server's `task_id` and `tool_call_id` are
  // DIFFERENT identifiers on the wire.
  // -------------------------------------------------------------------------
  //
  // `TaskId::new()` mints a fresh UUID in `register_full` (see
  // `crates/octos-agent/src/task_supervisor.rs:1180`) — distinct from the
  // LLM's `tool_call_id` which is stored as a separate field on the
  // `BackgroundTask` struct. `TurnSpawnCompleteEvent.task_id` and
  // `TaskUpdatedEvent.task_id` carry the supervisor UUID; only
  // `ToolStartedEvent.tool_call_id` carries the LLM id. The PR #131 tests
  // used identical values for both fields, hiding the divergence — in
  // production they always differ.
  //
  // Fix: translate `event.task_id → task.tool_call_id` via
  // `TaskStore.getTasks(...)` (populated by the task-watcher poll's
  // `crew:task_status` event), then look up + flip status via the
  // resolved id.
  it(
    "handleSpawnComplete resolves task_id → tool_call_id via TaskStore (codex final-3 bonus check)",
    async () => {
      const cmid = "cmid-task-bonus";
      // Realistic shapes: supervisor UUID vs LLM tool call id.
      const supervisorTaskId = "task_01J9PODCAST_SUPERVISOR";
      const llmToolCallId = "call_abc_llm_emitted";
      seedThread(cmid, "Generate a podcast");
      ThreadStore.appendAssistantToken(cmid, "Started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 3 });

      // tool/started registers the LLM's tool_call_id (NOT the
      // supervisor id) — this is how production wires arrive.
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: llmToolCallId,
          tool_name: "podcast_generate",
        },
      );

      // Seed the TaskStore mapping (production: the task watcher's
      // poll loop dispatches `crew:task_status` with a
      // `BackgroundTaskInfo` carrying both ids).
      const TaskStore = await import("@/store/task-store");
      TaskStore.mergeTask(SESSION, {
        id: supervisorTaskId,
        tool_name: "podcast_generate",
        tool_call_id: llmToolCallId,
        status: "running",
        started_at: "2026-05-15T00:00:00Z",
        error: null,
      });

      // turn/spawn_complete carries the SUPERVISOR task_id, not the
      // LLM tool_call_id.
      handleSpawnComplete(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          thread_id: cmid,
          task_id: supervisorTaskId,
          response_to_client_message_id: cmid,
          seq: 11,
          message_id: "msg-bonus",
          source: "background",
          cursor: { stream: SESSION, seq: 11 },
          persisted_at: "2026-05-15T00:00:05Z",
          content: "Podcast generated.",
        },
      );

      // Post-fix: handleSpawnComplete translated through TaskStore and
      // flipped the right tool call. Pre-fix it would have looked up by
      // `supervisorTaskId`, missed, and left the chip running.
      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find(
        (c) => c.id === llmToolCallId,
      );
      expect(tc?.status).toBe("complete");
      // Reset the TaskStore between tests (no afterEach helper exposed,
      // but each test seeds its own).
      TaskStore.clearTasks(SESSION);
    },
  );

  // -------------------------------------------------------------------------
  // Codex round 2 bug 2026-05-15: wire-borne `tool_call_id` is the
  // authoritative source.
  // -------------------------------------------------------------------------
  //
  // Pre-fix flow with PR #132 only:
  //   1. server emits `task/updated` with NO `turn_id`
  //   2. bridge guard rejects every such envelope → TaskStore stays empty
  //   3. `handleSpawnComplete` calls `resolveToolCallIdForTask` → empty
  //      lookup → returns raw supervisor `task_id`
  //   4. `findThreadIdForToolCall(supervisor_task_id)` misses (ThreadStore
  //      registered the LLM tool_call_id) → status flip no-ops
  //   5. spinner spins forever
  //
  // Post-fix: server adds `tool_call_id` directly on the wire (parallel
  // server PR). Bridge passes it through; handler uses it as the
  // authoritative source, bypassing the TaskStore race entirely. This
  // test asserts the happy path WITH the new field AND an empty TaskStore
  // (production scenario after both PRs land).
  it(
    "handleSpawnComplete uses wire-borne tool_call_id when TaskStore is empty (production scenario, codex round 2)",
    () => {
      const cmid = "cmid-wire-tcid-spawn";
      // Realistic shapes: supervisor UUID vs LLM tool call id (distinct).
      const supervisorTaskId = "task_01J_SUPERVISOR_PODCAST";
      const llmToolCallId = "call_llm_podcast_wire";
      seedThread(cmid, "Generate a podcast about Rust async");
      ThreadStore.appendAssistantToken(cmid, "Background work started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 4 });

      // tool/started registers the LLM tool_call_id (the chip's id).
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: llmToolCallId,
          tool_name: "podcast_generate",
        },
      );

      // CRITICAL: do NOT seed TaskStore. This is what the bridge guard
      // bug created in production — the watcher never polled because
      // `crew:bg_tasks` was never dispatched (every `task/updated` was
      // dropped at the guard). The fallback `resolveToolCallIdForTask`
      // lookup misses → returns the supervisor UUID → ThreadStore
      // lookup misses → spinner stuck. The wire-borne `tool_call_id`
      // is the only escape hatch in this scenario.

      handleSpawnComplete(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          thread_id: cmid,
          task_id: supervisorTaskId,
          // The parallel server PR adds this field — the LLM tool_call_id.
          tool_call_id: llmToolCallId,
          response_to_client_message_id: cmid,
          seq: 12,
          message_id: "msg-wire-tcid",
          source: "background",
          cursor: { stream: SESSION, seq: 12 },
          persisted_at: "2026-05-15T00:00:05Z",
          content: "Podcast generated.",
        },
      );

      // Post-fix: chip flips to complete via the wire-borne id, even
      // though TaskStore is empty (which is the production reality).
      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find(
        (c) => c.id === llmToolCallId,
      );
      expect(tc?.status).toBe("complete");
    },
  );

  it(
    "handleTaskUpdated state=failed uses wire-borne tool_call_id with no prior turn_id (codex round 2)",
    () => {
      // Server-side `TaskUpdatedEvent` carries NO `turn_id`. With the
      // bridge guard relaxed, the envelope is now ACCEPTED but
      // `event.turn_id` is `undefined`. Routing must go via
      // `findThreadIdForToolCall(wire.tool_call_id)` instead of trusting
      // `event.turn_id`. Pre-fix the chip stayed running because the
      // ThreadStore call hit a raw supervisor UUID that didn't match
      // any registered tool call.
      const cmid = "cmid-wire-tcid-failed";
      const supervisorTaskId = "task_01J_SUPERVISOR_FAIL";
      const llmToolCallId = "call_llm_failed_wire";
      seedThread(cmid, "deep_search");
      ThreadStore.appendAssistantToken(cmid, "Started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 2 });

      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: llmToolCallId,
          tool_name: "deep_search",
        },
      );

      // No TaskStore seeding (production reality, codex round 2 root
      // cause). No turn_id on the wire envelope.
      handleTaskUpdated(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          // turn_id intentionally OMITTED (server doesn't emit it).
          task_id: supervisorTaskId,
          tool_call_id: llmToolCallId,
          state: "failed",
        },
      );

      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find(
        (c) => c.id === llmToolCallId,
      );
      expect(tc?.status).toBe("error");
    },
  );

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

  // -------------------------------------------------------------------------
  // M10 Phase 6.2: spawn-ack rendering regression test
  // -------------------------------------------------------------------------
  //
  // Pre-fix (M10 Phase 6.1 probe): the bridge guard expected `params.delta`
  // but the server emits `params.text` (see
  // `octos_core::ui_protocol::MessageDeltaEvent`), so the spawn-ack
  // `message/delta` was rejected silently at the guard layer. The
  // pendingAssistant stayed empty; subsequent finalization produced a
  // timestamp-only ghost assistant bubble in the SPA. This test pins the
  // corrected behaviour: the streamed text lands in the bubble, and the
  // spawn_complete envelope appends a second bubble — two assistant rows
  // total (the user prompt is the third), not the three observed in the
  // wave-6m probe.
  it(
    "spawn-ack delta + persisted + spawn_complete renders 2 assistant bubbles (1 ack, 1 completion)",
    () => {
      const cmid = "cmid-spawn-ack-render";
      seedThread(cmid, "Use deep_search to find Rust news");

      // (1) message/delta — spawn-ack text streams in. With the pre-fix
      //     guard this frame was silently rejected; with the fix the text
      //     lands on `pendingAssistant.text`.
      handleMessageDelta(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          text: "Background work started for `deep_search`.",
        },
      );

      // (2) message/persisted — assistant ack row (no media). Promotion
      //     finalises the pending bubble because it now has content.
      handleMessagePersisted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          thread_id: cmid,
          seq: 4,
          role: "assistant",
          message_id: "msg-ack",
          source: "assistant",
          cursor: { stream: SESSION, seq: 4 },
          persisted_at: "2026-05-04T00:00:00Z",
        },
      );

      // (3) turn/spawn_complete — atomic completion envelope. Appends a
      //     fresh bubble under the same user prompt.
      handleSpawnComplete(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          thread_id: cmid,
          task_id: "task_deep_search_1",
          response_to_client_message_id: cmid,
          seq: 6,
          message_id: "msg-spawn-complete",
          source: "background",
          cursor: { stream: SESSION, seq: 6 },
          persisted_at: "2026-05-04T00:00:02Z",
          content: "✓ deep_search completed (research/_report.md)",
          media: ["research/_report.md"],
        },
      );

      const [thread] = ThreadStore.getThreads(SESSION);
      expect(thread.pendingAssistant).toBeNull();
      // Exactly TWO assistant rows: the ack bubble (with the streamed
      // delta text) and the spawn_complete bubble.
      expect(thread.responses).toHaveLength(2);

      // Ack bubble carries the spawn-ack text — NOT empty. This is the
      // load-bearing assertion for Phase 6.2.
      expect(thread.responses[0].text).toBe(
        "Background work started for `deep_search`.",
      );
      expect(thread.responses[0].status).toBe("complete");
      expect(thread.responses[0].files).toHaveLength(0);

      // Completion bubble carries the spawn_complete envelope's atomic
      // content + media list.
      expect(thread.responses[1].text).toBe(
        "✓ deep_search completed (research/_report.md)",
      );
      expect(thread.responses[1].files.map((f) => f.path)).toEqual([
        "research/_report.md",
      ]);
    },
  );

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
// Codex P2 round (2026-05-25, octos-web PR #156): file/attached routing
// MUST target the assistant message owning `tool_call_id` AND scope the
// turn-id fallback to the active session.
// ---------------------------------------------------------------------------

describe("file/attached: per-tool_call_id placement + scoped fallback (codex P2)", () => {
  function seedFinalizedToolCall(opts: {
    cmid: string;
    toolCallId: string;
    toolName: string;
    text?: string;
    committedSeq?: number;
  }): void {
    seedThread(opts.cmid, "ask");
    ThreadStore.appendAssistantToken(opts.cmid, opts.text ?? "Background work started.");
    ThreadStore.finalizeAssistant(opts.cmid, {
      committedSeq: opts.committedSeq ?? 4,
    });
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: opts.cmid,
        tool_call_id: opts.toolCallId,
        tool_name: opts.toolName,
      },
    );
  }

  it("targets the assistant response owning tool_call_id, not the latest sibling", () => {
    // Turn has TWO spawn_only completions. The first tool call lives on
    // response[0]; the second on response[1] (sibling). A `file/attached`
    // envelope for the FIRST tool call MUST attach to response[0], not
    // the latest response[1] (the pre-fix behaviour).
    const cmid = "cmid-multi-spawn";
    const firstToolCallId = "call_pptx_first";
    const secondToolCallId = "call_pptx_second";

    seedThread(cmid, "make two decks");
    // Foreground bubble + first tool call attached to response[0].
    ThreadStore.appendAssistantToken(cmid, "First deck queued.");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 3 });
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: firstToolCallId,
        tool_name: "mofa_slides",
      },
    );

    // Second assistant row via `turn/spawn_complete` — this is how a
    // sibling spawn_only completion lands in the same thread. Then
    // register the second tool call on this new row.
    handleSpawnComplete(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        task_id: "task_second_deck",
        response_to_client_message_id: cmid,
        seq: 5,
        message_id: "msg-second-deck",
        source: "background",
        cursor: { stream: SESSION, seq: 5 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "Second deck queued.",
      },
    );
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: secondToolCallId,
        tool_name: "mofa_slides",
      },
    );

    const before = ThreadStore.getThreads(SESSION)[0];
    // Sanity: two rows, second one owns secondToolCallId.
    expect(before.responses).toHaveLength(2);
    expect(
      before.responses[1].toolCalls.some((tc) => tc.id === secondToolCallId),
    ).toBe(true);
    expect(
      before.responses[0].toolCalls.some((tc) => tc.id === firstToolCallId),
    ).toBe(true);

    // Envelope for the FIRST tool call.
    handleFileAttached(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: firstToolCallId,
        path: "/decks/first.pptx",
      },
    );

    const [thread] = ThreadStore.getThreads(SESSION);
    // First response gets the file (it owns firstToolCallId).
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([
      "/decks/first.pptx",
    ]);
    // Second response (latest sibling) MUST stay empty — pre-fix it would
    // have received the file because `appendAssistantFile` picks the
    // latest assistant slot in the thread.
    expect(thread.responses[1].files).toEqual([]);
  });

  it("dedupes replays of the same envelope on the same tool_call_id + path", () => {
    const cmid = "cmid-replay";
    const toolCallId = "call_pptx_replay";
    seedFinalizedToolCall({ cmid, toolCallId, toolName: "mofa_slides" });

    const evt: FileAttachedEvent = {
      session_id: SESSION,
      turn_id: cmid,
      tool_call_id: toolCallId,
      path: "/decks/replay.pptx",
    };
    handleFileAttached({ sessionId: SESSION }, evt);
    handleFileAttached({ sessionId: SESSION }, evt);

    const [thread] = ThreadStore.getThreads(SESSION);
    // EXACTLY one file entry on the bubble — the replay is a no-op.
    const files = thread.responses[0].files.filter(
      (f) => f.path === "/decks/replay.pptx",
    );
    expect(files).toHaveLength(1);
  });

  it("drops envelopes with no tool_call_id whose turn_id resolves to a non-active session", () => {
    // Stale session bucket still resident in ThreadStore.
    const STALE = "sess-stale-fa";
    const ACTIVE = "sess-active-fa";
    const staleCmid = "cmid-stale-fa";
    const activeCmid = "cmid-active-fa";
    ThreadStore.addUserMessage(STALE, {
      text: "old",
      clientMessageId: staleCmid,
    });
    ThreadStore.addUserMessage(ACTIVE, {
      text: "new",
      clientMessageId: activeCmid,
    });

    // Envelope carries `turn_id = staleCmid` and NO tool_call_id. The
    // active router (`sessionId: ACTIVE`) MUST drop rather than route
    // into the stale session.
    handleFileAttached(
      { sessionId: ACTIVE },
      {
        session_id: ACTIVE,
        turn_id: staleCmid,
        path: "/decks/wrong-session.pptx",
      },
    );

    const [staleThread] = ThreadStore.getThreads(STALE);
    // Stale session's thread untouched — no file attached anywhere.
    // `addUserMessage` mints a `pendingAssistant` placeholder, so we
    // assert that placeholder carries no `files`, AND that no response
    // row was promoted/appended on the stale session.
    expect(staleThread.responses).toHaveLength(0);
    expect(staleThread.pendingAssistant?.files ?? []).toEqual([]);
    expect(staleThread.userMsg.files).toEqual([]);
    // ACTIVE thread is also untouched (no orphan bubble minted there).
    const [activeThread] = ThreadStore.getThreads(ACTIVE);
    expect(activeThread.responses).toHaveLength(0);
    expect(activeThread.pendingAssistant?.files ?? []).toEqual([]);
  });

  it("uses turn_id fallback when tool_call_id is absent AND turn_id resolves inside active scope", () => {
    // Preserves the existing fallback behaviour: an envelope without a
    // tool_call_id whose `turn_id` matches a thread in the ACTIVE
    // session attaches via `appendAssistantFile` (pending or latest
    // finalized).
    const cmid = "cmid-fallback-active";
    seedThread(cmid, "ask");
    ThreadStore.appendAssistantToken(cmid, "Body.");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 2 });

    handleFileAttached(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        // tool_call_id intentionally omitted.
        path: "/decks/fallback.pptx",
      },
    );

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([
      "/decks/fallback.pptx",
    ]);
  });

  it("drops envelopes whose tool_call_id matches no registered tool call AND turn_id is out of scope", () => {
    // Defence-in-depth: tool_call_id is present but unknown to
    // ThreadStore (e.g. the bubble has already been evicted on a
    // hydrate cycle), and the turn_id fallback can't find the thread
    // in the active session. The router MUST drop rather than mint
    // an orphan bubble.
    const ACTIVE = "sess-active-drop";
    ThreadStore.addUserMessage(ACTIVE, {
      text: "new",
      clientMessageId: "cmid-active-drop",
    });

    handleFileAttached(
      { sessionId: ACTIVE },
      {
        session_id: ACTIVE,
        turn_id: "cmid-ghost",
        tool_call_id: "call_ghost_nowhere",
        path: "/decks/ghost.pptx",
      },
    );

    const threads = ThreadStore.getThreads(ACTIVE);
    expect(threads).toHaveLength(1);
    // Active thread untouched.
    expect(threads[0].responses).toHaveLength(0);
    expect(threads[0].userMsg.files).toEqual([]);
  });

  it("moves a stale copy off the wrong sibling onto the tool_call_id owner (codex round 2)", () => {
    // Codex round-2 P2: the richer-envelope reducers
    // (`tryPromotePendingFromPersisted`, etc.) MAY have already
    // attached the same path to the "latest sibling" bubble. When
    // `file/attached` then arrives with the authoritative
    // `tool_call_id`, the same artefact MUST NOT render on two
    // sibling bubbles. Pre-fix the stale copy stayed put and the
    // owner-slot got a second copy → duplicate render.
    const cmid = "cmid-cross-slot";
    const ownerToolCallId = "call_pptx_owner";
    const stalePath = "/decks/from-message-persisted.pptx";

    seedThread(cmid, "ask");
    // First assistant row owns the tool call.
    ThreadStore.appendAssistantToken(cmid, "First.");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 2 });
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: ownerToolCallId,
        tool_name: "mofa_slides",
      },
    );

    // Add a second sibling row via spawn_complete and PRE-LOAD the
    // file there to simulate `appendAssistantFile` landing on the
    // wrong "latest" sibling.
    handleSpawnComplete(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        task_id: "task_unrelated",
        response_to_client_message_id: cmid,
        seq: 4,
        message_id: "msg-sibling",
        source: "background",
        cursor: { stream: SESSION, seq: 4 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "Sibling.",
      },
    );
    // Force a stale file onto the latest sibling — the exact bug shape
    // codex pointed at (richer-envelope reducer mis-routed).
    ThreadStore.appendAssistantFile(cmid, {
      filename: "from-message-persisted.pptx",
      path: stalePath,
      caption: "",
    });

    // Sanity: the file is on response[1] (latest), not response[0].
    const before = ThreadStore.getThreads(SESSION)[0];
    expect(before.responses[0].files.map((f) => f.path)).toEqual([]);
    expect(before.responses[1].files.map((f) => f.path)).toEqual([stalePath]);

    // `file/attached` envelope corrects placement: owner is
    // response[0] (carries `ownerToolCallId`).
    handleFileAttached(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: ownerToolCallId,
        path: stalePath,
      },
    );

    const [thread] = ThreadStore.getThreads(SESSION);
    // File moved: owner gets it, sibling no longer has it.
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([stalePath]);
    expect(thread.responses[1].files.map((f) => f.path)).toEqual([]);
  });

  it("preserves same-path files on OTHER tool-call owners (codex round 3)", () => {
    // Codex round-3 narrowing: when two distinct background completions
    // legitimately share a media path (e.g. each tool call delivered
    // `/decks/shared.pptx` because they synthesised the same artefact
    // for the same prompt), both owners MUST retain their copy.
    // Pre-fix the cross-slot cleanup stripped the file from the earlier
    // tool-call owner as soon as the LATER `file/attached` for a
    // different tool_call_id landed.
    const cmid = "cmid-shared-path";
    const firstToolCallId = "call_pptx_first_owner";
    const secondToolCallId = "call_pptx_second_owner";
    const sharedPath = "/decks/shared.pptx";

    seedThread(cmid, "ask");
    ThreadStore.appendAssistantToken(cmid, "First.");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 2 });
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: firstToolCallId,
        tool_name: "mofa_slides",
      },
    );

    handleSpawnComplete(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        task_id: "task_second",
        response_to_client_message_id: cmid,
        seq: 4,
        message_id: "msg-second",
        source: "background",
        cursor: { stream: SESSION, seq: 4 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "Second.",
      },
    );
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: secondToolCallId,
        tool_name: "mofa_slides",
      },
    );

    // First envelope: shared path delivered for the FIRST owner.
    handleFileAttached(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: firstToolCallId,
        path: sharedPath,
      },
    );

    // Sanity: first owner has the file, second doesn't yet.
    const mid = ThreadStore.getThreads(SESSION)[0];
    expect(mid.responses[0].files.map((f) => f.path)).toEqual([sharedPath]);
    expect(mid.responses[1].files.map((f) => f.path)).toEqual([]);

    // Second envelope: SAME shared path delivered for the SECOND
    // owner. The first owner's copy MUST stay (sibling has its OWN
    // tool call; not the "naive media sibling" that legacy
    // mis-placement targets).
    handleFileAttached(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: secondToolCallId,
        path: sharedPath,
      },
    );

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([sharedPath]);
    expect(thread.responses[1].files.map((f) => f.path)).toEqual([sharedPath]);
  });

  it("replaces the mutated ThreadMessage so React.memo repaints (codex round 3)", () => {
    // Codex round-3 immutable-slot finding: `ThreadAssistantBubble` is
    // wrapped in `React.memo`. If `appendAssistantFileToToolCall`
    // mutates `slot.files` in place, the bubble holds the same
    // `message` reference and won't repaint — the stale file stays
    // visible. Assert that BOTH the owner slot AND the stripped sibling
    // get a fresh `ThreadMessage` reference after the envelope runs.
    const cmid = "cmid-repaint";
    const ownerToolCallId = "call_pptx_owner_repaint";
    const stalePath = "/decks/repaint.pptx";

    seedThread(cmid, "ask");
    ThreadStore.appendAssistantToken(cmid, "Foreground.");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 2 });
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: ownerToolCallId,
        tool_name: "mofa_slides",
      },
    );

    // Sibling row WITHOUT a tool call (the legacy mis-routing target).
    handleSpawnComplete(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        task_id: "task_naive_sibling",
        response_to_client_message_id: cmid,
        seq: 4,
        message_id: "msg-naive",
        source: "background",
        cursor: { stream: SESSION, seq: 4 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "Naive sibling.",
      },
    );
    // Pre-load the stale file onto the naive sibling.
    ThreadStore.appendAssistantFile(cmid, {
      filename: "repaint.pptx",
      path: stalePath,
      caption: "",
    });

    const before = ThreadStore.getThreads(SESSION)[0];
    const ownerBefore = before.responses[0];
    const siblingBefore = before.responses[1];

    handleFileAttached(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: ownerToolCallId,
        path: stalePath,
      },
    );

    const after = ThreadStore.getThreads(SESSION)[0];
    // Identity changed for the owner (file added) — React.memo will
    // diff and repaint.
    expect(after.responses[0]).not.toBe(ownerBefore);
    // Identity changed for the sibling (file stripped) — repaint OK.
    expect(after.responses[1]).not.toBe(siblingBefore);
    expect(after.responses[0].files.map((f) => f.path)).toEqual([stalePath]);
    expect(after.responses[1].files.map((f) => f.path)).toEqual([]);
  });

  it("does NOT strip same-path file from a sibling that has its own tool_call (codex round 5)", () => {
    // Codex round-5 narrowing: absence of a `file/attached` claim is
    // not proof of staleness on a tool-call-owning sibling. The
    // sibling may legitimately own the path via the redundant
    // `media[]` delivery channel (which `file/attached` complements,
    // per the redundancy contract) before its own claim envelope
    // arrives — or its `file/attached` may be absent entirely on
    // hydrate / fallback paths. Cleanup is limited to "naive media
    // siblings" (NO tool_calls); tool-call-owning siblings are left
    // intact.
    //
    // Trade-off: when both the legacy mis-placement AND the
    // authoritative envelope land on tool-call-owning slots, the
    // SPA may briefly show the file on two bubbles. The redundancy
    // contract prioritises NOT losing legitimate attachments over
    // hiding rare visual duplicates — losing a slide button breaks
    // the user, a duplicated button is recoverable on next refresh.
    const cmid = "cmid-respect-other-owner";
    const ownerToolCallId = "call_owner_path";
    const otherToolCallId = "call_other_owns_media";
    const sharedPath = "/decks/shared-by-media.pptx";

    seedThread(cmid, "ask");
    ThreadStore.appendAssistantToken(cmid, "Foreground.");
    ThreadStore.finalizeAssistant(cmid, { committedSeq: 2 });
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: ownerToolCallId,
        tool_name: "mofa_slides",
      },
    );

    // Sibling with its own tool_call AND its own media[] from
    // `turn/spawn_complete` (the documented redundant delivery
    // channel) — file/attached for the sibling hasn't arrived yet
    // (or never will, per the soak failure mode).
    handleSpawnComplete(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        task_id: "task_other",
        response_to_client_message_id: cmid,
        seq: 4,
        message_id: "msg-other",
        source: "background",
        cursor: { stream: SESSION, seq: 4 },
        persisted_at: "2026-05-04T00:00:00Z",
        content: "Other sibling.",
        media: [sharedPath],
      },
    );
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: otherToolCallId,
        tool_name: "mofa_slides",
      },
    );

    // Sanity: response[1] (other owner) holds `sharedPath`; response[0]
    // (target owner) does not.
    const before = ThreadStore.getThreads(SESSION)[0];
    expect(before.responses[1].files.map((f) => f.path)).toEqual([sharedPath]);
    expect(before.responses[0].files.map((f) => f.path)).toEqual([]);

    // `file/attached` for `ownerToolCallId` lands.
    handleFileAttached(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: ownerToolCallId,
        path: sharedPath,
      },
    );

    const [thread] = ThreadStore.getThreads(SESSION);
    // Owner gets the file; the OTHER tool-call-owning sibling
    // keeps its `media[]`-delivered copy untouched. The redundancy
    // contract is honoured: no legitimate attachment is lost.
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([sharedPath]);
    expect(thread.responses[1].files.map((f) => f.path)).toEqual([sharedPath]);
  });

  it("attaches the file to a still-pending assistant when the tool call hangs off pendingAssistant", () => {
    // Edge: a tool call registered on the still-in-flight
    // pendingAssistant (foreground turn with a spawn_only nested
    // call) must still receive the file when the envelope arrives
    // before `finalizeAssistant`.
    const cmid = "cmid-pending";
    const toolCallId = "call_pending_pptx";
    seedThread(cmid, "ask");
    ThreadStore.appendAssistantToken(cmid, "Streaming…");
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: toolCallId,
        tool_name: "mofa_slides",
      },
    );

    handleFileAttached(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: toolCallId,
        path: "/decks/pending.pptx",
      },
    );

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant?.files.map((f) => f.path)).toEqual([
      "/decks/pending.pptx",
    ]);
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
      { session_id: SESSION, turn_id: cmid, text: "partial" },
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
        content: "late artifact",
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
      { session_id: SESSION, turn_id: cmid, text: "Hello" },
    );
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, text: ", world" },
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
      { session_id: SESSION, turn_id: cmid, text: "Persisted answer" },
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
      { session_id: SESSION, turn_id: cmid, text: "partial" },
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
  emitFileAttached?: (e: FileAttachedEvent) => void;
  emitTaskUpdated?: (e: TaskUpdatedEvent) => void;
  emitTaskOutputDelta?: (e: TaskOutputDeltaEvent) => void;
  emitTurnLifecycle?: (
    e: TurnStartedEvent | TurnCompletedEvent | TurnErrorEvent,
  ) => void;
  emitApprovalRequested?: (e: ApprovalRequestedEvent) => void;
  emitToolStarted?: (e: ToolStartedEvent) => void;
  emitToolProgress?: (e: ToolProgressEvent) => void;
  emitToolCompleted?: (e: ToolCompletedEvent) => void;
  emitProgressUpdated?: (e: ProgressUpdatedEvent) => void;
  emitRouterStatus?: (e: RouterStatusEvent) => void;
  emitRouterFailover?: (e: RouterFailoverEvent) => void;
  emitQueueState?: (e: QueueStateEvent) => void;

  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  sendTurn = vi.fn(async () => ({ accepted: true }));
  interruptTurn = vi.fn(async () => ({ interrupted: true }));
  respondToApproval = vi.fn(async () => ({
    approval_id: "x",
    accepted: true,
    status: "ok",
  }));
  hydrateSession = vi.fn(async () => null);
  callMethod = vi.fn(async () => null);

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
  onFileAttached(h: (e: FileAttachedEvent) => void) {
    this.emitFileAttached = h;
    return () => {
      this.emitFileAttached = undefined;
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
  onToolStarted(h: (e: ToolStartedEvent) => void) {
    this.emitToolStarted = h;
    return () => {
      this.emitToolStarted = undefined;
    };
  }
  onToolProgress(h: (e: ToolProgressEvent) => void) {
    this.emitToolProgress = h;
    return () => {
      this.emitToolProgress = undefined;
    };
  }
  onToolCompleted(h: (e: ToolCompletedEvent) => void) {
    this.emitToolCompleted = h;
    return () => {
      this.emitToolCompleted = undefined;
    };
  }
  onProgressUpdated(h: (e: ProgressUpdatedEvent) => void) {
    this.emitProgressUpdated = h;
    return () => {
      this.emitProgressUpdated = undefined;
    };
  }
  onRouterStatus(h: (e: RouterStatusEvent) => void) {
    this.emitRouterStatus = h;
    return () => {
      this.emitRouterStatus = undefined;
    };
  }
  onRouterFailover(h: (e: RouterFailoverEvent) => void) {
    this.emitRouterFailover = h;
    return () => {
      this.emitRouterFailover = undefined;
    };
  }
  onQueueState(h: (e: QueueStateEvent) => void) {
    this.emitQueueState = h;
    return () => {
      this.emitQueueState = undefined;
    };
  }
  onConnectionStateChange(): () => void {
    return () => {};
  }
  getConnectionState(): "connected" {
    return "connected";
  }
  onWarning(): () => void {
    return () => {};
  }
  onSessionTitleUpdated(): () => void {
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

// ---------------------------------------------------------------------------
// PR fix/restore-progress-cost-meta-events — regressions A / B / C
// ---------------------------------------------------------------------------

describe("regression A: tool/* events fan out into crew:tool_progress", () => {
  it("tool/started dispatches crew:tool_progress with the tool name", () => {
    const dispatched: Event[] = [];
    handleToolStarted(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-A1",
        tool_call_id: "tc-1",
        tool_name: "shell",
        arguments: { command: "cargo test" },
      },
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe("crew:tool_progress");
    const detail = (dispatched[0] as CustomEvent).detail;
    expect(detail.tool).toBe("shell");
    expect(detail.sessionId).toBe(SESSION);
    expect(detail.turnId).toBe("cmid-A1");
    // The component reads `detail.message` (eventually rendered after the
    // `[info]/.../` prefix strip), so a non-empty placeholder is required
    // to flip the spinner ON.
    expect(typeof detail.message).toBe("string");
    expect(detail.message.length).toBeGreaterThan(0);
  });

  it("tool/progress dispatches crew:tool_progress with the status message", () => {
    const dispatched: Event[] = [];
    handleToolProgress(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-A2",
        tool_call_id: "tc-2",
        message: "downloading 42%",
        progress_pct: 42,
      },
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe("crew:tool_progress");
    const detail = (dispatched[0] as CustomEvent).detail;
    expect(detail.message).toBe("downloading 42%");
  });

  it("codex P3: tool/progress preserves the tool_name from the preceding tool/started", () => {
    // Without the cache, the spinner row's tool label flipped from
    // e.g. `shell` to `tc-xyz` on the first progress frame because
    // `tool/progress` carries no `tool_name` on the wire. The cache
    // populated by `handleToolStarted` keeps the friendly name
    // sticky for the whole call.
    const dispatched: Event[] = [];
    const cfg = {
      sessionId: SESSION,
      dispatchEvent: (e: Event) => dispatched.push(e),
    };
    handleToolStarted(cfg, {
      session_id: SESSION,
      turn_id: "cmid-A4",
      tool_call_id: "tc-keep",
      tool_name: "shell",
    });
    handleToolProgress(cfg, {
      session_id: SESSION,
      turn_id: "cmid-A4",
      tool_call_id: "tc-keep",
      message: "running",
    });
    expect(dispatched).toHaveLength(2);
    expect((dispatched[0] as CustomEvent).detail.tool).toBe("shell");
    // The crucial regression: the SECOND event must still show "shell"
    // instead of "tc-keep".
    expect((dispatched[1] as CustomEvent).detail.tool).toBe("shell");
  });

  it("tool/progress falls back to tool_call_id when no tool/started was seen", () => {
    // Defensive case: server-side bug or replay skips the
    // `tool/started` frame. We still want to render *something*.
    const dispatched: Event[] = [];
    handleToolProgress(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-A5",
        tool_call_id: "tc-unknown",
        message: "running",
      },
    );
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as CustomEvent).detail.tool).toBe("tc-unknown");
  });

  it("codex round-2 P2: tool/* events also populate the bubble's ThreadStore tool card", () => {
    // Pre-fix the synchronous tool lifecycle only fired the transient
    // spinner; the finalised assistant bubble had no tool card. The
    // fix mirrors `tool/started` → addToolCall, `tool/progress` →
    // appendToolProgress, `tool/completed` → setToolCallStatus, the
    // same pattern `handleTaskUpdated` uses for spawn_only tasks.
    const cmid = "cmid-Atool-card";
    seedThread(cmid, "ask");
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: "tc-card",
        tool_name: "shell",
      },
    );
    let [thread] = ThreadStore.getThreads(SESSION);
    let tc = thread.pendingAssistant?.toolCalls.find((t) => t.id === "tc-card");
    expect(tc).toBeDefined();
    expect(tc!.name).toBe("shell");
    expect(tc!.status).toBe("running");

    handleToolProgress(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: "tc-card",
        message: "executing cargo test",
      },
    );
    [thread] = ThreadStore.getThreads(SESSION);
    tc = thread.pendingAssistant?.toolCalls.find((t) => t.id === "tc-card");
    expect(tc!.progress.map((p) => p.message)).toContain("executing cargo test");

    handleToolCompleted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: "tc-card",
        tool_name: "shell",
        success: true,
      },
    );
    [thread] = ThreadStore.getThreads(SESSION);
    tc = thread.pendingAssistant?.toolCalls.find((t) => t.id === "tc-card");
    expect(tc!.status).toBe("complete");
  });

  it("codex round-2 P2: tool/completed with success=false flips the chip to error", () => {
    const cmid = "cmid-Atool-err";
    seedThread(cmid, "ask");
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: "tc-err",
        tool_name: "shell",
      },
    );
    handleToolCompleted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: "tc-err",
        tool_name: "shell",
        success: false,
      },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.pendingAssistant?.toolCalls.find((t) => t.id === "tc-err");
    expect(tc!.status).toBe("error");
  });

  it("tool/completed dispatches crew:tool_progress with success status", () => {
    const dispatched: Event[] = [];
    handleToolCompleted(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-A3",
        tool_call_id: "tc-3",
        tool_name: "shell",
        success: true,
        duration_ms: 1250,
      },
    );
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as CustomEvent).detail.tool).toBe("shell");
  });

  it("tool/completed marks crew:tool_progress terminal for non-spawn_only tools (legacy spinner clear signal)", () => {
    // The lifted `ToolProgressIndicator` (chat-layout level) cannot
    // rely on `crew:thinking false` for foreground tool completions —
    // for synchronous tools the terminal flag is the dedicated clear
    // signal. For spawn_only tools we DEFER the terminal flag (see
    // the spawn_only test below) since the foreground completion is
    // only an ack.
    const dispatched: Event[] = [];
    handleToolCompleted(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-A4",
        tool_call_id: "tc-4",
        tool_name: "shell",
        success: true,
      },
    );
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as CustomEvent).detail.terminal).toBe(true);
    expect((dispatched[0] as CustomEvent).detail.tool).toBe("shell");
  });

  it("tool/completed does NOT mark crew:tool_progress terminal for spawn_only tools (defect A, 2026-05-22)", () => {
    // Defect A (M9 follow-up): the foreground `tool/completed` for a
    // spawn_only tool (`podcast_generate`, `run_pipeline`, `fm_tts`,
    // etc.) fires ~2ms after `tool/started` — it's only the
    // supervisor's ack, not a signal that the background task has
    // finished. Pre-fix this dispatched a terminal `crew:tool_progress`
    // event that cleared the lifted spinner while the background task
    // was still running (and planted a static Check on the tool card).
    // Post-fix the dispatched event keeps `terminal` unset; the real
    // terminal signal arrives via `task/updated:completed` →
    // `handleTaskUpdated`'s dedicated terminal dispatch.
    const dispatched: Event[] = [];
    handleToolCompleted(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-A4-spawn",
        tool_call_id: "tc-4-spawn",
        tool_name: "podcast_generate",
        success: true,
      },
    );
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as CustomEvent).detail.terminal).toBeUndefined();
    expect((dispatched[0] as CustomEvent).detail.tool).toBe("podcast_generate");
  });

  it("tool/completed for a spawn_only tool leaves toolCall.status running (defect A, 2026-05-22)", () => {
    // Companion to the test above — the chip itself must NOT flip.
    // Seed a tool call via `handleToolStarted`, fire foreground
    // `tool/completed` (the spawn_only ack leg), and assert the
    // ThreadStore tool call is still `"running"`.
    const cmid = "cmid-defectA-status";
    seedThread(cmid, "generate a podcast");
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: "tc-podcast-defectA",
        tool_name: "run_pipeline",
      },
    );
    handleToolCompleted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: "tc-podcast-defectA",
        tool_name: "run_pipeline",
        success: true,
      },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.pendingAssistant?.toolCalls.find(
      (t) => t.id === "tc-podcast-defectA",
    );
    expect(tc).toBeDefined();
    expect(tc!.status).toBe("running");
  });

  it("tool/completed with success=false for a spawn_only tool DOES flip to error (real failure)", () => {
    // The spawn_only defer is ONLY for `success: true` — a foreground
    // failure means the supervisor refused to spawn the work, so it's
    // genuinely terminal and the chip MUST flip to "error" right away.
    const cmid = "cmid-defectA-err";
    seedThread(cmid, "synthesise");
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: "tc-fmtts-err",
        tool_name: "fm_tts",
      },
    );
    handleToolCompleted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: "tc-fmtts-err",
        tool_name: "fm_tts",
        success: false,
      },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.pendingAssistant?.toolCalls.find(
      (t) => t.id === "tc-fmtts-err",
    );
    expect(tc).toBeDefined();
    expect(tc!.status).toBe("error");
  });

  it("tool/started and tool/progress do NOT carry the terminal flag", () => {
    // Sanity: only `tool/completed` is terminal — `tool/started` and
    // `tool/progress` keep the spinner alive.
    const dispatched: Event[] = [];
    handleToolStarted(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-A5",
        tool_call_id: "tc-5",
        tool_name: "fm_tts",
      },
    );
    handleToolProgress(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-A5",
        tool_call_id: "tc-5",
        message: "synthesising 1/3",
      },
    );
    expect(dispatched).toHaveLength(2);
    expect((dispatched[0] as CustomEvent).detail.terminal).toBeUndefined();
    expect((dispatched[1] as CustomEvent).detail.terminal).toBeUndefined();
  });
});

describe("regression B: progress/updated fans out into crew:cost (+ crew:message_meta)", () => {
  it("token_cost_update dispatches crew:cost with input/output tokens + session cost", () => {
    const dispatched: Event[] = [];
    handleProgressUpdated(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-B1",
        metadata: {
          kind: "token_cost_update",
          token_cost: {
            input_tokens: 1000,
            output_tokens: 50,
            session_cost: 0.0085,
          },
        },
      },
    );
    const cost = dispatched.find((e) => e.type === "crew:cost") as
      | CustomEvent
      | undefined;
    expect(cost).toBeDefined();
    expect(cost!.detail.sessionId).toBe(SESSION);
    expect(cost!.detail.input_tokens).toBe(1000);
    expect(cost!.detail.output_tokens).toBe(50);
    expect(cost!.detail.session_cost).toBe(0.0085);
  });

  it("token_cost_update with model label ALSO dispatches crew:message_meta", () => {
    const dispatched: Event[] = [];
    handleProgressUpdated(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-B2",
        metadata: {
          kind: "token_cost_update",
          label: "moonshot@autodl/kimi-k2.5",
          token_cost: {
            input_tokens: 30000,
            output_tokens: 2000,
            session_cost: 0.0228,
          },
        },
      },
    );
    const meta = dispatched.find((e) => e.type === "crew:message_meta") as
      | CustomEvent
      | undefined;
    expect(meta).toBeDefined();
    expect(meta!.detail.model).toBe("moonshot@autodl/kimi-k2.5");
    expect(meta!.detail.tokens_in).toBe(30000);
    expect(meta!.detail.tokens_out).toBe(2000);
    expect(meta!.detail.session_cost).toBe(0.0228);
  });

  it("ignores progress/updated with kind != token_cost_update", () => {
    const dispatched: Event[] = [];
    handleProgressUpdated(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-B3",
        metadata: { kind: "status", message: "thinking" },
      },
    );
    expect(dispatched).toHaveLength(0);
  });

  it("status_word dispatches crew:status_word with the rotating word", () => {
    // Server-side StatusIndicator rotates a creative status word every
    // ~8s and emits `progress/updated{kind:"status_word"}` carrying the
    // current word in `metadata.label`. The router lifts that onto
    // `crew:status_word` so the in-flight ThinkingIndicator can swap
    // the word in the bubble.
    const dispatched: Event[] = [];
    handleProgressUpdated(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-status-word",
        metadata: { kind: "status_word", label: "Pondering" },
      },
    );
    const ev = dispatched.find((e) => e.type === "crew:status_word") as
      | CustomEvent<{
          sessionId: string;
          topic?: string;
          turnId?: string;
          word: string;
        }>
      | undefined;
    expect(ev).toBeDefined();
    expect(ev!.detail.word).toBe("Pondering");
    expect(ev!.detail.sessionId).toBe(SESSION);
    expect(ev!.detail.turnId).toBe("cmid-status-word");
  });

  it("status_word with empty/missing label does NOT dispatch", () => {
    // Defensive: ignore status_word frames that carry no word so the
    // bubble doesn't flicker to an empty caption.
    const dispatched: Event[] = [];
    handleProgressUpdated(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-status-empty",
        metadata: { kind: "status_word", label: "" },
      },
    );
    handleProgressUpdated(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-status-missing",
        metadata: { kind: "status_word" },
      },
    );
    expect(dispatched.filter((e) => e.type === "crew:status_word")).toHaveLength(
      0,
    );
  });

  it("token_cost_update prefers metadata.token_cost.model over metadata.label", () => {
    // Server PR `feat/cost-update-carry-model` adds an authoritative
    // `metadata.token_cost.model` field, populated from
    // `LlmProvider::provider_metadata_for_index(...).model` so failover
    // / routed responses surface the model that actually answered. The
    // router must prefer the new field and fall back to the legacy
    // `metadata.label` carrier only when the new field is absent.
    const dispatched: Event[] = [];
    handleProgressUpdated(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-B4-prefers-token-cost-model",
        metadata: {
          kind: "token_cost_update",
          label: "stale-label-from-older-bridge",
          token_cost: {
            input_tokens: 120,
            output_tokens: 45,
            model: "deepseek-v4-pro",
          },
        },
      },
    );
    const meta = dispatched.find((e) => e.type === "crew:message_meta") as
      | CustomEvent
      | undefined;
    expect(meta).toBeDefined();
    expect(meta!.detail.model).toBe("deepseek-v4-pro");
  });

  it("token_cost_update falls back to metadata.label when token_cost.model is absent", () => {
    // Back-compat: older daemons that don't populate
    // `token_cost.model` yet still flow through the legacy
    // `metadata.label` carrier. The router must not regress those
    // flows before the fleet is upgraded.
    const dispatched: Event[] = [];
    handleProgressUpdated(
      { sessionId: SESSION, dispatchEvent: (e) => dispatched.push(e) },
      {
        session_id: SESSION,
        turn_id: "cmid-B5-falls-back-to-label",
        metadata: {
          kind: "token_cost_update",
          label: "moonshot@autodl/kimi-k2.5",
          token_cost: {
            input_tokens: 12,
            output_tokens: 7,
          },
        },
      },
    );
    const meta = dispatched.find((e) => e.type === "crew:message_meta") as
      | CustomEvent
      | undefined;
    expect(meta).toBeDefined();
    expect(meta!.detail.model).toBe("moonshot@autodl/kimi-k2.5");
  });
});

describe("regression C: turn/completed stamps per-turn meta snapshot onto the finalised bubble", () => {
  it("snapshot accumulated from progress/updated lands as message.meta on completion", () => {
    seedThread("cmid-C1", "ask");
    ThreadStore.appendAssistantToken("cmid-C1", "Hello.");
    // Seed the turn-start anchor (sets firstSeenAtMs).
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-C1" },
    );
    // TWO cost frames so we get a real delta (the first frame just
    // sets the baseline per codex round-3 P2 — see the multi-frame
    // turn test below for the rationale).
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-C1",
        metadata: {
          kind: "token_cost_update",
          label: "moonshot@autodl/kimi-k2.5",
          token_cost: { input_tokens: 50, output_tokens: 5 },
        },
      },
    );
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-C1",
        metadata: {
          kind: "token_cost_update",
          label: "moonshot@autodl/kimi-k2.5",
          token_cost: { input_tokens: 150, output_tokens: 25 },
        },
      },
    );
    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-C1", reason: "stop" },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    const meta = thread.responses[0].meta;
    expect(meta).toBeDefined();
    expect(meta!.model).toBe("moonshot@autodl/kimi-k2.5");
    expect(meta!.tokens_in).toBe(100); // 150 - 50 baseline
    expect(meta!.tokens_out).toBe(20); // 25 - 5 baseline
    // duration_s is computed from `nowMs() - firstSeenAtMs`; under
    // synchronous test execution it should be a tiny non-negative
    // number. Asserting `>= 0` keeps the test stable across hosts.
    expect(meta!.duration_s).toBeGreaterThanOrEqual(0);
  });

  it("codex round-2 + 3 P2: per-turn meta tokens are the DELTA, not session cumulative totals", () => {
    // Wire ordering: turn-1 emits one cost frame, then turn-2's
    // frame whose `input_tokens` / `output_tokens` reflect
    // session-cumulative growth across both turns. The finalised
    // bubble for turn-2 must show the DELTA (turn-2 alone), not the
    // session-total.
    //
    // Codex round-3 P2 follow-up: the FIRST turn after a fresh
    // session/restore has no baseline yet, so the snapshot self-seeds
    // from the first observed cumulative — turn-1's footer shows
    // tokens_in/out=0 (delta against itself). This is the conservative
    // fallback for the restored-session case the codex review flagged;
    // a fresh session does the same thing because the runtime can't
    // distinguish the two. The PR description explains the trade-off
    // and links a follow-up issue for a per-turn rather than
    // cumulative counter on the server surface.
    seedThread("cmid-T1", "first ask");
    ThreadStore.appendAssistantToken("cmid-T1", "first reply");
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-T1" },
    );
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-T1",
        metadata: {
          kind: "token_cost_update",
          label: "moonshot@autodl/kimi-k2.5",
          token_cost: { input_tokens: 100, output_tokens: 20 },
        },
      },
    );
    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-T1", reason: "stop" },
    );
    // Turn-1: cumulative=(100,20), baseline self-seeded to (100,20),
    // delta=(0,0). Footer text effectively omits tokens.
    let [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses[0].meta?.tokens_in).toBe(0);
    expect(thread.responses[0].meta?.tokens_out).toBe(0);

    // Turn 2: cumulative is (250, 60); per-turn delta is (150, 40).
    seedThread("cmid-T2", "second ask");
    ThreadStore.appendAssistantToken("cmid-T2", "second reply");
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-T2" },
    );
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-T2",
        metadata: {
          kind: "token_cost_update",
          label: "moonshot@autodl/kimi-k2.5",
          token_cost: { input_tokens: 250, output_tokens: 60 },
        },
      },
    );
    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-T2", reason: "stop" },
    );
    const threadsAfter = ThreadStore.getThreads(SESSION);
    const t2Thread = threadsAfter.find((t) => t.id === "cmid-T2");
    expect(t2Thread).toBeDefined();
    const turn2 = t2Thread!.responses[0];
    expect(turn2.meta?.tokens_in).toBe(150); // 250 - 100 baseline
    expect(turn2.meta?.tokens_out).toBe(40); // 60 - 20 baseline
  });

  it("codex round-3 P2: multi-frame turn within a session computes delta against baseline correctly", () => {
    // Within a single turn, multiple `progress/updated` frames carry
    // the same cumulative growing across the turn. The DELTA should
    // always be against the per-session baseline, not the first frame
    // we saw this turn.
    seedThread("cmid-multi", "ask");
    ThreadStore.appendAssistantToken("cmid-multi", "reply");
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-multi" },
    );
    // Two frames in this turn — first sets the baseline self-seed,
    // second should derive a non-zero delta against that baseline.
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-multi",
        metadata: {
          kind: "token_cost_update",
          label: "test",
          token_cost: { input_tokens: 1000, output_tokens: 100 },
        },
      },
    );
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-multi",
        metadata: {
          kind: "token_cost_update",
          label: "test",
          token_cost: { input_tokens: 1050, output_tokens: 130 },
        },
      },
    );
    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-multi", reason: "stop" },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses[0].meta?.tokens_in).toBe(50); // 1050 - 1000
    expect(thread.responses[0].meta?.tokens_out).toBe(30); // 130 - 100
  });

  it("turn/completed without any cost snapshot still finalises the bubble (no meta)", () => {
    seedThread("cmid-C2", "ask");
    ThreadStore.appendAssistantToken("cmid-C2", "Hello.");
    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-C2", reason: "stop" },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Hello.");
  });

  it("codex P2: meta lands on the response even when message/persisted finalised the bubble first", () => {
    // Wire ordering: progress/updated → message/delta →
    // message/persisted (with content, finalises) → turn/completed.
    // Pre-fix the snapshot was deleted at turn/completed because
    // `finalizeAssistant` bails when `pendingAssistant` is null. The
    // `patchLastResponseMeta` fall-back lands the meta on the
    // already-finalised response.
    const cmid = "cmid-Cpersist";
    seedThread(cmid, "ask");
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid },
    );
    // TWO frames (codex round-3 P2: first frame seeds baseline, second
    // gives the real delta).
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        metadata: {
          kind: "token_cost_update",
          label: "moonshot@autodl/kimi-k2.5",
          token_cost: { input_tokens: 4000, output_tokens: 100 },
        },
      },
    );
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        metadata: {
          kind: "token_cost_update",
          label: "moonshot@autodl/kimi-k2.5",
          token_cost: { input_tokens: 13000, output_tokens: 400 },
        },
      },
    );
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, text: "Hello." },
    );
    // `message/persisted` arrives with a non-empty pending → promotion
    // finalises the bubble before `turn/completed` ever lands.
    handleMessagePersisted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        seq: 99,
        role: "assistant",
        message_id: "msg-Cpersist",
        source: "assistant",
        cursor: { stream: SESSION, seq: 99 },
        persisted_at: "2026-05-04T00:00:00Z",
      },
    );
    // At this point the bubble is already in `responses`, pending is
    // null. The pre-fix `handleTurnCompleted` lost the snapshot here.
    const beforeCompleted = ThreadStore.getThreads(SESSION)[0];
    expect(beforeCompleted.pendingAssistant).toBeNull();
    expect(beforeCompleted.responses).toHaveLength(1);
    expect(beforeCompleted.responses[0].meta).toBeUndefined();

    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, reason: "stop" },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses[0].meta?.model).toBe("moonshot@autodl/kimi-k2.5");
    expect(thread.responses[0].meta?.tokens_in).toBe(9000); // 13000 - 4000
    expect(thread.responses[0].meta?.tokens_out).toBe(300); // 400 - 100
  });

  it("codex round-4 P2: counter baselines seed independently per-counter", () => {
    // Frame 1 carries only output_tokens. Round-3 self-seed pinned
    // inputTokens baseline to 0; a later frame's first input_tokens
    // value of 9000 was then attributed in full to this turn. Round-4
    // fix: each counter seeds INDEPENDENTLY when first observed.
    seedThread("cmid-RT4", "ask");
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-RT4" },
    );
    // Frame 1: output_tokens only.
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-RT4",
        metadata: {
          kind: "token_cost_update",
          label: "test",
          token_cost: { output_tokens: 80 },
        },
      },
    );
    // Frame 2: introduces input_tokens for the first time. Its
    // baseline must self-seed here (not be pinned to 0 by frame 1).
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-RT4",
        metadata: {
          kind: "token_cost_update",
          label: "test",
          token_cost: { input_tokens: 9000, output_tokens: 90 },
        },
      },
    );
    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-RT4", reason: "stop" },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    // tokens_in must be 0 (frame 2 = self-seed baseline for input),
    // NOT 9000 (the historical cumulative).
    expect(thread.responses[0].meta?.tokens_in).toBe(0);
    expect(thread.responses[0].meta?.tokens_out).toBe(10); // 90 - 80
  });

  it("codex round-3 P2: patchLastResponseMeta targets the assistant row, not a tool/media tail", () => {
    // After `message/persisted` promotes the text assistant, a
    // subsequent tool result or media companion can land as the new
    // tail of `responses`. The naive tail-stamp would put the meta
    // on the wrong row and leave the visible answer blank. The fix
    // walks the responses tail-to-head looking for an assistant row.
    const cmid = "cmid-Ptail";
    seedThread(cmid, "ask");
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid },
    );
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        metadata: {
          kind: "token_cost_update",
          label: "claude",
          token_cost: { input_tokens: 50, output_tokens: 10 },
        },
      },
    );
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        metadata: {
          kind: "token_cost_update",
          label: "claude",
          token_cost: { input_tokens: 120, output_tokens: 25 },
        },
      },
    );
    handleMessageDelta(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, text: "answer text" },
    );
    handleMessagePersisted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        thread_id: cmid,
        seq: 50,
        role: "assistant",
        message_id: "msg-assistant",
        source: "assistant",
        cursor: { stream: SESSION, seq: 50 },
        persisted_at: "2026-05-04T00:00:00Z",
      },
    );
    // Inject a tool row after the assistant promotion. The tail of
    // responses is now this tool row, NOT the assistant answer.
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      role: "tool",
      content: "tool output",
      thread_id: cmid,
      timestamp: "2026-05-04T00:00:01Z",
      seq: 51,
    });
    const beforeCompleted = ThreadStore.getThreads(SESSION)[0];
    // The assistant row is responses[0]; some tool row is responses[1].
    expect(beforeCompleted.responses.length).toBeGreaterThanOrEqual(2);
    const tailRoleBefore =
      beforeCompleted.responses[beforeCompleted.responses.length - 1].role;
    expect(tailRoleBefore).toBe("tool");

    handleTurnCompleted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid, reason: "stop" },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    // Find the assistant response by role — that's the one that
    // should now carry the meta.
    const assistant = thread.responses.find((r) => r.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.meta?.model).toBe("claude");
    expect(assistant!.meta?.tokens_in).toBe(70); // 120 - 50 baseline
    // The tool row must NOT have been stamped.
    const tool = thread.responses.find((r) => r.role === "tool");
    expect(tool?.meta).toBeUndefined();
  });

  it("turn/error also stamps the snapshot so the bubble's meta survives errored turns", () => {
    seedThread("cmid-C3", "ask");
    ThreadStore.appendAssistantToken("cmid-C3", "partial");
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: "cmid-C3" },
    );
    handleProgressUpdated(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-C3",
        metadata: {
          kind: "token_cost_update",
          label: "anthropic/claude",
          token_cost: { input_tokens: 5, output_tokens: 1 },
        },
      },
    );
    handleTurnError(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: "cmid-C3",
        error: { code: -1, message: "boom" },
      },
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses[0].status).toBe("error");
    expect(thread.responses[0].meta?.model).toBe("anthropic/claude");
  });
});

// ---------------------------------------------------------------------------
// Wave4-A: router/status, router/failover, queue/state DOM fan-out
// ---------------------------------------------------------------------------

describe("Wave4-A: router/status fans out into crew:mode_update", () => {
  it("dispatches crew:mode_update with normalized adaptiveMode + provider/breaker context", () => {
    const dispatched: Event[] = [];
    handleRouterStatus(
      {
        sessionId: SESSION,
        dispatchEvent: (e) => dispatched.push(e),
      },
      {
        session_id: SESSION,
        provider_name: "openrouter/anthropic/claude-opus-4-7",
        mode: "lane",
        qos_ranking: true,
        lane_scores: {
          "openrouter/anthropic/claude-opus-4-7": 0.92,
        },
        circuit_breakers: {},
      },
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe("crew:mode_update");
    const detail = (dispatched[0] as CustomEvent).detail;
    expect(detail.adaptiveMode).toBe("lane");
    expect(detail.providerName).toBe(
      "openrouter/anthropic/claude-opus-4-7",
    );
    expect(detail.qosRanking).toBe(true);
    expect(detail.laneScores["openrouter/anthropic/claude-opus-4-7"]).toBe(
      0.92,
    );
  });

  it("normalises unknown mode strings to null so the pill doesn't render stale state", () => {
    const dispatched: Event[] = [];
    handleRouterStatus(
      {
        sessionId: SESSION,
        dispatchEvent: (e) => dispatched.push(e),
      },
      {
        session_id: SESSION,
        provider_name: "p",
        mode: "speculative", // not one of off|lane|hedge today
        qos_ranking: false,
        lane_scores: {},
        circuit_breakers: {},
      },
    );
    expect((dispatched[0] as CustomEvent).detail.adaptiveMode).toBeNull();
  });
});

describe("Wave4-A: router/failover fans out into crew:router_failover", () => {
  it("dispatches crew:router_failover with from/to/reason/elapsedMs", () => {
    const dispatched: Event[] = [];
    handleRouterFailover(
      {
        sessionId: SESSION,
        dispatchEvent: (e) => dispatched.push(e),
      },
      {
        session_id: SESSION,
        from_provider: "openrouter/openai/gpt-5",
        to_provider: "openrouter/anthropic/claude-opus-4-7",
        reason: "circuit_breaker_open",
        elapsed_ms: 1200,
      },
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe("crew:router_failover");
    const detail = (dispatched[0] as CustomEvent).detail;
    expect(detail.from).toBe("openrouter/openai/gpt-5");
    expect(detail.to).toBe("openrouter/anthropic/claude-opus-4-7");
    expect(detail.reason).toBe("circuit_breaker_open");
    expect(detail.elapsedMs).toBe(1200);
  });
});

describe("Wave4-A: queue/state fans out into crew:queue_state", () => {
  it("dispatches crew:queue_state with pendingCount + head", () => {
    const dispatched: Event[] = [];
    handleQueueState(
      {
        sessionId: SESSION,
        dispatchEvent: (e) => dispatched.push(e),
      },
      {
        session_id: SESSION,
        pending_count: 3,
        head_client_message_id: "cmid-head",
      },
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe("crew:queue_state");
    const detail = (dispatched[0] as CustomEvent).detail;
    expect(detail.pendingCount).toBe(3);
    expect(detail.head).toBe("cmid-head");
  });
});
