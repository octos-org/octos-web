/**
 * thread-store unit tests (M8.10 PR #3, issue #627).
 *
 * Covers the 12 cases mandated by the PR plan:
 *   1. creates_thread_on_user_message
 *   2. appends_streaming_tokens_to_pending_assistant
 *   3. routes_tool_progress_to_correct_tool_call_via_tool_id
 *   4. late_arrival_assistant_lands_in_correct_thread
 *   5. parallel_threads_dont_interleave_responses
 *   6. finalize_sets_history_seq_from_committed_seq
 *   7. replays_history_jsonl_into_thread_structure
 *   8. synthesizes_threads_for_legacy_messages_without_thread_id
 *   9. tool_retries_collapse_into_one_tool_call_with_retry_count
 *  10. abort_marks_pending_assistant_as_complete_with_partial_text
 *  11. reordered_arrival_preserves_send_order
 *  12. subscribe_notifies_on_change
 *
 * M9-γ-3 (issue #840): every test in this file runs twice — once with
 * the `projection_v1` flag OFF (legacy reducer is the source of truth)
 * and once ON (the shim translates each entry point into a projection
 * envelope and ingests it in parallel; legacy reducer continues to
 * back `getThreads()`). Parametrising with `describe.each` keeps the
 * test names distinguishable in the runner output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ThreadStore from "./thread-store";
import {
  __resetProjectionForTests,
  __setProjectionV1ForTests,
  getEnvelopes,
  getProjection,
  getProjectionWithMetrics,
  ingest as projectionIngest,
  projectionStoreKey,
} from "./projection-store";
import {
  __resetUiProtocolRuntimeForTest,
  __setActiveBridgeForTest,
} from "@/runtime/ui-protocol-runtime";
import { METHODS, type UiProtocolBridge } from "@/runtime/ui-protocol-bridge";

function stubBridgeForMessagesPage(messages: unknown[]): {
  callCount: () => number;
} {
  let count = 0;
  const stub: Partial<UiProtocolBridge> = {
    callMethod: async <T,>(method: string): Promise<T> => {
      if (method === METHODS.SESSION_MESSAGES_PAGE) {
        count += 1;
        return {
          messages,
          has_more: false,
          next_offset: messages.length,
        } as T;
      }
      throw new Error("unexpected method: " + method);
    },
    start: async () => {},
    stop: async () => {},
    sendTurn: () => Promise.reject(new Error("not used")),
    interruptTurn: () => Promise.reject(new Error("not used")),
    respondToApproval: () => Promise.reject(new Error("not used")),
    hydrateSession: () => Promise.resolve(null),
    onMessageDelta: () => () => {},
    onMessagePersisted: () => () => {},
    onSpawnComplete: () => () => {},
    onFileAttached: () => () => {},
    onTaskUpdated: () => () => {},
    onTaskOutputDelta: () => () => {},
    onTurnLifecycle: () => () => {},
    onApprovalRequested: () => () => {},
    onConnectionStateChange: () => () => {},
    getConnectionState: () => "connected" as const,
    onWarning: () => () => {},
  };
  __setActiveBridgeForTest("any", stub as UiProtocolBridge);
  return { callCount: () => count };
}

afterEach(() => {
  ThreadStore.__resetForTests();
  __resetProjectionForTests();
  __resetUiProtocolRuntimeForTest();
  vi.unstubAllGlobals();
});

const SESSION = "sess-test";

function makeUser(text: string, cmid: string) {
  return ThreadStore.addUserMessage(SESSION, {
    text,
    clientMessageId: cmid,
  });
}

const FLAG_STATES = [
  { label: "projectionV1=false", projectionV1: false },
  { label: "projectionV1=true", projectionV1: true },
] as const;

describe.each(FLAG_STATES)("thread-store [$label]", ({ projectionV1 }) => {
  beforeEach(() => {
    __setProjectionV1ForTests(projectionV1);
  });

  it("creates_thread_on_user_message", () => {
    makeUser("hello", "cmid-1");
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("cmid-1");
    expect(threads[0].userMsg.text).toBe("hello");
    expect(threads[0].userMsg.clientMessageId).toBe("cmid-1");
    expect(threads[0].pendingAssistant).not.toBeNull();
    expect(threads[0].pendingAssistant?.status).toBe("streaming");
    expect(threads[0].responses).toHaveLength(0);
  });

  it("appends_streaming_tokens_to_pending_assistant", () => {
    makeUser("hi", "cmid-1");
    ThreadStore.appendAssistantToken("cmid-1", "Hello");
    ThreadStore.appendAssistantToken("cmid-1", ", world");
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant?.text).toBe("Hello, world");
  });

  it("routes_tool_progress_to_correct_tool_call_via_tool_id", () => {
    makeUser("search", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "tc_a", "deep_search");
    ThreadStore.addToolCall("cmid-1", "tc_b", "fm_tts");
    ThreadStore.appendToolProgress("cmid-1", "tc_a", "[info] fetched 5 sources");
    ThreadStore.appendToolProgress("cmid-1", "tc_b", "rendering audio");
    ThreadStore.appendToolProgress("cmid-1", "tc_a", "[info] reranking");

    const [thread] = ThreadStore.getThreads(SESSION);
    const tcs = thread.pendingAssistant?.toolCalls ?? [];
    expect(tcs.map((tc) => tc.id)).toEqual(["tc_a", "tc_b"]);
    expect(tcs[0].progress.map((p) => p.message)).toEqual([
      "[info] fetched 5 sources",
      "[info] reranking",
    ]);
    expect(tcs[1].progress.map((p) => p.message)).toEqual(["rendering audio"]);
  });

  it("late_arrival_assistant_lands_in_correct_thread", () => {
    // User sends two questions back-to-back; the slow answer arrives later.
    makeUser("slow news Q", "cmid-slow");
    makeUser("fast voices Q", "cmid-fast");

    // Fast assistant finalizes first.
    ThreadStore.replaceAssistantText("cmid-fast", "Voices: alice, bob.");
    ThreadStore.finalizeAssistant("cmid-fast", { committedSeq: 4 });

    // Then the slow answer arrives.
    ThreadStore.replaceAssistantText("cmid-slow", "News: today...");
    ThreadStore.finalizeAssistant("cmid-slow", { committedSeq: 6 });

    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.map((t) => t.id)).toEqual(["cmid-slow", "cmid-fast"]);
    expect(threads[0].responses[0].text).toBe("News: today...");
    expect(threads[1].responses[0].text).toBe("Voices: alice, bob.");
  });

  it("parallel_threads_dont_interleave_responses", () => {
    makeUser("Q1", "cmid-1");
    makeUser("Q2", "cmid-2");

    // Streaming tokens for both threads interleave on the wire — they must
    // each land in their own thread, never bleed across.
    ThreadStore.appendAssistantToken("cmid-1", "A1-part1 ");
    ThreadStore.appendAssistantToken("cmid-2", "A2-part1 ");
    ThreadStore.appendAssistantToken("cmid-1", "A1-part2");
    ThreadStore.appendAssistantToken("cmid-2", "A2-part2");

    const threads = ThreadStore.getThreads(SESSION);
    const t1 = threads.find((t) => t.id === "cmid-1");
    const t2 = threads.find((t) => t.id === "cmid-2");
    expect(t1?.pendingAssistant?.text).toBe("A1-part1 A1-part2");
    expect(t2?.pendingAssistant?.text).toBe("A2-part1 A2-part2");
  });

  it("finalize_sets_history_seq_from_committed_seq", () => {
    makeUser("hi", "cmid-1");
    ThreadStore.appendAssistantToken("cmid-1", "Hello.");
    ThreadStore.finalizeAssistant("cmid-1", {
      committedSeq: 7,
      meta: {
        model: "gpt-x",
        tokens_in: 12,
        tokens_out: 34,
        duration_s: 1,
      },
    });

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant).toBeNull();
    expect(thread.responses).toHaveLength(1);
    const a = thread.responses[0];
    expect(a.intra_thread_seq).toBe(7);
    expect(a.historySeq).toBe(7);
    expect(a.status).toBe("complete");
    expect(a.text).toBe("Hello.");
    expect(a.meta?.model).toBe("gpt-x");
  });

  it("replays_history_jsonl_into_thread_structure", () => {
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "Q1",
        client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "A1",
        response_to_client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 2,
        role: "user",
        content: "Q2",
        client_message_id: "cmid-2",
        thread_id: "cmid-2",
        timestamp: "2026-04-28T10:01:00Z",
      },
      {
        seq: 3,
        role: "assistant",
        content: "A2",
        response_to_client_message_id: "cmid-2",
        thread_id: "cmid-2",
        timestamp: "2026-04-28T10:01:05Z",
      },
    ]);

    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.map((t) => t.id)).toEqual(["cmid-1", "cmid-2"]);
    expect(threads[0].userMsg.text).toBe("Q1");
    expect(threads[0].responses).toHaveLength(1);
    expect(threads[0].responses[0].text).toBe("A1");
    expect(threads[1].responses[0].text).toBe("A2");
  });

  it("synthesizes_threads_for_legacy_messages_without_thread_id", () => {
    // Legacy JSONL has no thread_id — synthesizer derives one per role-flip.
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "old Q1",
        client_message_id: "cm-old-1",
        timestamp: "2026-04-01T00:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "old A1",
        timestamp: "2026-04-01T00:00:10Z",
      },
      {
        seq: 2,
        role: "user",
        content: "old Q2",
        client_message_id: "cm-old-2",
        timestamp: "2026-04-01T00:01:00Z",
      },
      {
        seq: 3,
        role: "assistant",
        content: "old A2",
        timestamp: "2026-04-01T00:01:10Z",
      },
    ]);

    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(2);
    // Each user message roots its own thread; the trailing assistant inherits.
    expect(threads[0].id).toBe("cm-old-1");
    expect(threads[0].responses[0].text).toBe("old A1");
    expect(threads[1].id).toBe("cm-old-2");
    expect(threads[1].responses[0].text).toBe("old A2");
  });

  it("tool_retries_collapse_into_one_tool_call_with_retry_count", () => {
    makeUser("retry me", "cmid-1");
    // Same tool name, retried 3 times with different ids — should collapse.
    ThreadStore.addToolCall("cmid-1", "tc_a1", "get_weather");
    ThreadStore.setToolCallStatus("cmid-1", "tc_a1", "error");
    ThreadStore.addToolCall("cmid-1", "tc_a2", "get_weather");
    ThreadStore.setToolCallStatus("cmid-1", "tc_a2", "error");
    ThreadStore.addToolCall("cmid-1", "tc_a3", "get_weather");
    ThreadStore.setToolCallStatus("cmid-1", "tc_a3", "complete");

    const [thread] = ThreadStore.getThreads(SESSION);
    const tcs = thread.pendingAssistant?.toolCalls ?? [];
    expect(tcs).toHaveLength(1);
    expect(tcs[0].name).toBe("get_weather");
    expect(tcs[0].retryCount).toBe(2);
    // Latest id and status preserved.
    expect(tcs[0].id).toBe("tc_a3");
    expect(tcs[0].status).toBe("complete");
  });

  it("abort_marks_pending_assistant_as_complete_with_partial_text", () => {
    makeUser("write me an essay", "cmid-1");
    ThreadStore.appendAssistantToken("cmid-1", "Once upon a time...");
    // User aborts mid-stream — finalize with partial text.
    ThreadStore.finalizeAssistant("cmid-1", { status: "complete" });

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant).toBeNull();
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Once upon a time...");
    expect(thread.responses[0].status).toBe("complete");
  });

  it("reordered_arrival_preserves_send_order", () => {
    // Today's broken session: news first (slow), voices second (fast).
    // Wire arrival has voices answer arriving FIRST (it's a fast turn).
    // Render order must still pair each Q with its A by send order.
    const tNews = 1000;
    const tVoices = 2000;
    // Inject deterministic timestamps via the mock-compatible path.
    const realNow = Date.now;
    let mockNow = tNews;
    vi.spyOn(Date, "now").mockImplementation(() => mockNow);

    makeUser("今日新闻速递", "cm-news");
    mockNow = tVoices;
    makeUser("你有哪些内置语音", "cm-voices");

    // Voices answer arrives first (fast) — tokens stream into cm-voices.
    ThreadStore.appendAssistantToken("cm-voices", "Voices: alice, bob.");
    ThreadStore.finalizeAssistant("cm-voices", { committedSeq: 4 });

    // News answer arrives later — tokens stream into cm-news.
    ThreadStore.appendAssistantToken("cm-news", "News: today the markets...");
    ThreadStore.finalizeAssistant("cm-news", { committedSeq: 6 });

    const threads = ThreadStore.getThreads(SESSION);
    // Strict invariant: thread ordering follows user-message timestamp,
    // not arrival timestamp.
    expect(threads.map((t) => t.userMsg.text)).toEqual([
      "今日新闻速递",
      "你有哪些内置语音",
    ]);
    expect(threads[0].responses[0].text).toBe("News: today the markets...");
    expect(threads[1].responses[0].text).toBe("Voices: alice, bob.");

    Date.now = realNow;
  });

  it("subscribe_notifies_on_change", () => {
    const notifications: number[] = [];
    let n = 0;
    const unsub = ThreadStore.subscribe(() => {
      notifications.push(++n);
    });

    makeUser("hi", "cm-1");
    ThreadStore.appendAssistantToken("cm-1", "Hello");
    ThreadStore.finalizeAssistant("cm-1", { committedSeq: 1 });

    expect(notifications.length).toBeGreaterThanOrEqual(3);
    unsub();

    const before = notifications.length;
    makeUser("hi again", "cm-2");
    expect(notifications.length).toBe(before); // unsubscribed
  });

  // ---------------------------------------------------------------------------
  // Edge: missing thread_id resolution
  // ---------------------------------------------------------------------------

  it("resolveEventThreadId_uses_payload_when_present", () => {
    makeUser("hi", "cm-1");
    expect(ThreadStore.resolveEventThreadId(SESSION, undefined, "cm-1")).toBe(
      "cm-1",
    );
  });

  it("resolveEventThreadId_synthesizes_from_pending_assistant", () => {
    makeUser("hi", "cm-1");
    expect(ThreadStore.resolveEventThreadId(SESSION, undefined, undefined)).toBe(
      "cm-1",
    );
  });

  it("resolveEventThreadId_returns_null_when_no_pending_assistant", () => {
    expect(
      ThreadStore.resolveEventThreadId("unknown-session", undefined, undefined),
    ).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // History rehydration on mount (M8.10 follow-up, issue #633)
  //
  // ChatThreadV2 needs `loadHistory` to populate the thread store from the
  // server's per-session messages endpoint. Without these tests the bug
  // identified in #633 (v2 page reload renders empty chat) regresses.
  // ---------------------------------------------------------------------------

  it("loadHistory_replays_into_threads_grouped_by_thread_id", async () => {
    // 4-message history → 2 threads, every record carries thread_id.
    const messages = [
      {
        seq: 0,
        role: "user",
        content: "Q1",
        client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "A1",
        response_to_client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 2,
        role: "user",
        content: "Q2",
        client_message_id: "cmid-2",
        thread_id: "cmid-2",
        timestamp: "2026-04-28T10:01:00Z",
      },
      {
        seq: 3,
        role: "assistant",
        content: "A2",
        response_to_client_message_id: "cmid-2",
        thread_id: "cmid-2",
        timestamp: "2026-04-28T10:01:05Z",
      },
    ];

    const { callCount } = stubBridgeForMessagesPage(messages);

    await ThreadStore.loadHistory(SESSION);
    expect(callCount()).toBe(1);

    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.map((t) => t.id)).toEqual(["cmid-1", "cmid-2"]);
    expect(threads[0].userMsg.text).toBe("Q1");
    expect(threads[0].responses).toHaveLength(1);
    expect(threads[0].responses[0].text).toBe("A1");
    expect(threads[1].userMsg.text).toBe("Q2");
    expect(threads[1].responses).toHaveLength(1);
    expect(threads[1].responses[0].text).toBe("A2");

    // Second call is a no-op — already loaded for this session/topic key.
    await ThreadStore.loadHistory(SESSION);
    expect(callCount()).toBe(1);

    // `force: true` bypasses the cache so the mount-effect retry can recover
    // from server persistence latency that returned a partial first fetch.
    await ThreadStore.loadHistory(SESSION, undefined, { force: true });
    expect(callCount()).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // tool_call_id propagation (PR #682 follow-up)
  //
  // The tool-call bubble's `data-tool-call-id` must reflect the SERVER-issued
  // `tool_call_id` exactly. When the backend omits one, the entry must carry
  // an empty `id` so the renderer can drop the DOM attribute rather than
  // synthesizing a fake shape that no external consumer can correlate.
  // ---------------------------------------------------------------------------

  it("addToolCall_preserves_server_tool_call_id_verbatim", () => {
    makeUser("call something", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "call_abc123", "run_pipeline");
    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.pendingAssistant?.toolCalls?.[0];
    expect(tc?.id).toBe("call_abc123");
    // Important: id must NOT be a synthetic shape like "run_pipeline_0" or
    // "tc_run_pipeline_<ts>_<rand>".
    expect(tc?.id).not.toMatch(/^tc_/);
    expect(tc?.id).not.toMatch(/^run_pipeline_\d+$/);
  });

  it("addToolCall_keeps_id_empty_when_server_omits_tool_call_id", () => {
    makeUser("legacy backend", "cmid-1");
    // Legacy daemon: server doesn't send `tool_call_id`, so the bridge
    // forwards an empty string. The store must keep it empty (no synthesis).
    ThreadStore.addToolCall("cmid-1", "", "run_pipeline");
    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.pendingAssistant?.toolCalls?.[0];
    expect(tc?.id).toBe("");
    expect(tc?.name).toBe("run_pipeline");
  });

  it("appendToolProgress_routes_by_name_when_id_is_empty", () => {
    makeUser("legacy backend", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "", "run_pipeline");
    // Legacy progress events also omit the id — we still want them to land
    // on the right bubble. Fallback: most recent tool call by name.
    ThreadStore.appendToolProgress(
      "cmid-1",
      "",
      "[info] step 1",
      "run_pipeline",
    );
    ThreadStore.appendToolProgress(
      "cmid-1",
      "",
      "[info] step 2",
      "run_pipeline",
    );
    const [thread] = ThreadStore.getThreads(SESSION);
    const tcs = thread.pendingAssistant?.toolCalls ?? [];
    expect(tcs).toHaveLength(1);
    expect(tcs[0].progress.map((p) => p.message)).toEqual([
      "[info] step 1",
      "[info] step 2",
    ]);
  });

  it("addToolCall_with_empty_ids_keeps_distinct_names_separate", () => {
    makeUser("legacy backend", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "", "run_pipeline");
    ThreadStore.addToolCall("cmid-1", "", "fm_tts");
    const [thread] = ThreadStore.getThreads(SESSION);
    const tcs = thread.pendingAssistant?.toolCalls ?? [];
    // Two different tools with empty ids must NOT collapse — only same-name
    // retries collapse via the existing retryCount path.
    expect(tcs.map((tc) => tc.name)).toEqual(["run_pipeline", "fm_tts"]);
    expect(tcs.every((tc) => tc.id === "")).toBe(true);
  });

  it("setToolCallStatus_routes_by_name_when_id_is_empty", () => {
    makeUser("legacy backend", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "", "run_pipeline");
    ThreadStore.setToolCallStatus("cmid-1", "", "complete", "run_pipeline");
    const [thread] = ThreadStore.getThreads(SESSION);
    const tcs = thread.pendingAssistant?.toolCalls ?? [];
    expect(tcs).toHaveLength(1);
    expect(tcs[0].status).toBe("complete");
  });

  // Defect B (M9 follow-up, 2026-05-22): late `appendToolProgress` for a
  // `tool_call_id` whose originating bubble has been finalised into
  // `thread.responses` AND a more-recent assistant response has been
  // appended (e.g. a `turn/spawn_complete` completion bubble after the
  // foreground ack response). Pre-fix `pickAssistantSlot` returned the
  // most-recent assistant, `findIndex` missed on it, and the function
  // minted a stub `{id: toolCallId, name: toolName ?? "", status:
  // "running"}` on the wrong slot — surfacing as a SECOND, empty
  // ToolCallBubble titled "tool". The fix scans every assistant slot
  // in the thread for the owning `toolCallId` before falling back to
  // stub creation; the late progress now lands on the originating
  // (earlier) response and the most-recent response stays untouched.
  it("appendToolProgress_routes_late_progress_to_originating_finalized_slot_not_stub_on_newer_response", () => {
    // 1) Foreground turn finalises with a tool call on the assistant
    //    ack response (this is the "originating bubble").
    makeUser("generate a podcast", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "tc-podcast-1", "podcast_generate");
    ThreadStore.appendAssistantToken(
      "cmid-1",
      "Started background podcast generation.",
    );
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 1 });

    // 2) A later spawn_complete bubble appends onto the same thread
    //    as a NEW finalised assistant response. After this the most
    //    recent assistant slot picked by `pickAssistantSlot` is the
    //    spawn_complete bubble — NOT the originating ack response.
    ThreadStore.appendCompletionBubble("cmid-1", {
      text: "✓ podcast generated (output.mp3)",
      media: ["out/output.mp3"],
      spawnComplete: true,
      sourceClientMessageId: "cmid-1",
      historySeq: 17,
      messageId: "msg-spawn-1",
      persistedAt: new Date().toISOString(),
      sessionId: SESSION,
    });

    // Sanity: two finalised responses, neither has been opened a new
    // pendingAssistant on. The first response carries the tool call.
    const before = ThreadStore.getThreads(SESSION)[0];
    expect(before.responses.length).toBeGreaterThanOrEqual(2);
    const originating = before.responses.find(
      (r) =>
        r.role === "assistant" &&
        r.toolCalls.some((tc) => tc.id === "tc-podcast-1"),
    );
    expect(originating).toBeDefined();
    const completionBubble = before.responses[before.responses.length - 1];
    expect(completionBubble.toolCalls).toHaveLength(0);

    // 3) Late `tool/progress` arrives for the originating tool call
    //    (e.g. a `crew:task_status` mirror after the foreground turn
    //    ended). Without the defect-B fix this would mint a stub on
    //    the completion bubble — surfacing as a phantom empty
    //    "tool" titled ToolCallBubble next to the file row.
    ThreadStore.appendToolProgress(
      "cmid-1",
      "tc-podcast-1",
      "synthesising 7/10",
      "podcast_generate",
    );

    const after = ThreadStore.getThreads(SESSION)[0];

    // No phantom stub on the most-recent (completion) bubble.
    const completionAfter = after.responses[after.responses.length - 1];
    expect(
      completionAfter.toolCalls,
      "late tool_progress must route back to the originating finalised slot, not mint a stub on a later response (defect B 2026-05-22)",
    ).toHaveLength(0);

    // The originating finalised response received the progress entry.
    const originatingAfter = after.responses.find(
      (r) =>
        r.role === "assistant" &&
        r.toolCalls.some((tc) => tc.id === "tc-podcast-1"),
    );
    expect(originatingAfter).toBeDefined();
    const tc = originatingAfter!.toolCalls.find(
      (t) => t.id === "tc-podcast-1",
    );
    expect(tc).toBeDefined();
    expect(tc!.progress.map((p) => p.message)).toContain("synthesising 7/10");
  });

  it("loadHistory_synthesizes_threads_for_legacy_records_without_thread_id", async () => {
    // Legacy daemon: no thread_id on any record. Synthesizer must derive one
    // per user-message role-flip so the chat still groups into 2 threads.
    const messages = [
      {
        seq: 0,
        role: "user",
        content: "old Q1",
        client_message_id: "cm-old-1",
        timestamp: "2026-04-01T00:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "old A1",
        timestamp: "2026-04-01T00:00:10Z",
      },
      {
        seq: 2,
        role: "user",
        content: "old Q2",
        client_message_id: "cm-old-2",
        timestamp: "2026-04-01T00:01:00Z",
      },
      {
        seq: 3,
        role: "assistant",
        content: "old A2",
        timestamp: "2026-04-01T00:01:10Z",
      },
    ];

    stubBridgeForMessagesPage(messages);

    await ThreadStore.loadHistory(SESSION);

    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(2);
    expect(threads[0].id).toBe("cm-old-1");
    expect(threads[0].userMsg.text).toBe("old Q1");
    expect(threads[0].responses).toHaveLength(1);
    expect(threads[0].responses[0].text).toBe("old A1");
    expect(threads[1].id).toBe("cm-old-2");
    expect(threads[1].userMsg.text).toBe("old Q2");
    expect(threads[1].responses).toHaveLength(1);
    expect(threads[1].responses[0].text).toBe("old A2");
  });

  // ---------------------------------------------------------------------------
  // overflow-stress regression (mini1, post-#680): phantom assistant bubble
  //
  // Production failure mode: under tight concurrent windows, the daemon emits
  // a `token` or `replace` event tagged with thread_id=cmid-X, but cmid-X has
  // already been finalized (its `done` arrived earlier). Pre-fix, the thread
  // store called `ensurePendingAssistant` unconditionally — creating a SECOND
  // assistant slot for an already-finalized thread. The DOM then rendered an
  // extra bubble (`filled=8/5` on a 5-message scenario) that never paired
  // with any user prompt.
  //
  // The right behaviour: late streaming chunks for an already-finalized
  // thread are cross-talk artifacts. Drop them and bump a counter rather
  // than silently spawn a phantom bubble.
  // ---------------------------------------------------------------------------

  it("appendAssistantToken_does_not_spawn_phantom_after_finalize", () => {
    makeUser("Q1", "cmid-1");
    ThreadStore.appendAssistantToken("cmid-1", "Done.");
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 1 });

    // Late cross-talk token arrives for the already-finalized thread.
    ThreadStore.appendAssistantToken("cmid-1", " stray late chunk");

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(
      thread.pendingAssistant,
      "late token must NOT spawn a phantom pending — that bubble would render as an extra assistant in the DOM",
    ).toBeNull();
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Done.");
  });

  it("replaceAssistantText_does_not_spawn_phantom_after_finalize", () => {
    makeUser("Q1", "cmid-1");
    ThreadStore.replaceAssistantText("cmid-1", "Final answer.");
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 1 });

    // Late cross-talk replace arrives for the already-finalized thread.
    ThreadStore.replaceAssistantText("cmid-1", "Stale replace from another stream");

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(
      thread.pendingAssistant,
      "late replace must NOT spawn a phantom pending",
    ).toBeNull();
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Final answer.");
  });

  it("late_tool_progress_after_finalize_attaches_to_finalized_response_not_phantom", () => {
    // spawn_only background flow: tool_start fires during the stream, then
    // `done` finalizes. tool_progress / file events keep arriving for the
    // background task minutes later. They must update the finalized
    // response's tool call entry — never spawn a fresh pending bubble.
    makeUser("run deep_research", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "tc-research-1", "deep_research");
    ThreadStore.replaceAssistantText("cmid-1", "Researching...");
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 5 });

    // Late progress for the spawn_only tool — must attach to the existing
    // finalized response, not create a phantom pending bubble.
    ThreadStore.appendToolProgress(
      "cmid-1",
      "tc-research-1",
      "[info] late progress chunk",
    );

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(
      thread.pendingAssistant,
      "late tool_progress must update the finalized response's tool call, not phantom-spawn",
    ).toBeNull();
    expect(thread.responses).toHaveLength(1);
    const tcs = thread.responses[0].toolCalls;
    expect(tcs).toHaveLength(1);
    expect(tcs[0].progress.map((p) => p.message)).toContain(
      "[info] late progress chunk",
    );
  });

  it("five_concurrent_threads_do_not_spawn_phantom_bubbles_under_late_cross_talk", () => {
    // The exact production scenario: 5 user messages spawn 5 threads;
    // they finalize independently; then late cross-talk events fire.
    // The DOM must only show 5 assistant bubbles — never 6+.
    const cmids = ["cm-1", "cm-2", "cm-3", "cm-4", "cm-5"];
    for (const cmid of cmids) {
      makeUser(`Q-${cmid}`, cmid);
      ThreadStore.replaceAssistantText(cmid, `A-${cmid}`);
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 1 });
    }

    // Cross-talk: a stray token tagged with cmid-2 arrives long after
    // cmid-2 finalized. Pre-fix, this would phantom-spawn an extra
    // assistant bubble inside cmid-2's thread.
    ThreadStore.appendAssistantToken("cm-2", " stray late chunk");
    ThreadStore.replaceAssistantText("cm-4", "Stale replace text");

    const threads = ThreadStore.getThreads(SESSION);
    // Each thread should have exactly one finalized response and zero
    // pending assistants — total assistant bubbles in DOM == 5.
    let totalAssistants = 0;
    for (const t of threads) {
      expect(t.pendingAssistant).toBeNull();
      totalAssistants += t.responses.filter((r) => r.role === "assistant").length;
    }
    expect(
      totalAssistants,
      "5 user messages must yield exactly 5 assistant bubbles, not 6+ phantom bubbles from late cross-talk",
    ).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // Production phantom (mini1 dspfac.crew.ominix.io 2026-05-08): Q1 sent over
  // the WS lane finalizes correctly with content, then a second
  // `addUserMessage` for the SAME clientMessageId (legacy mirror, retry,
  // double-publish) re-creates a streaming `pendingAssistant` on the
  // already-finalized thread — surfacing as a phantom empty bubble that
  // never finalizes. `isRunning` then stays true for that thread because
  // the renderer reads `pendingAssistant.status === "streaming"`, blocking
  // the user from seeing a clean post-send state.
  //
  // The fix: addUserMessage MUST NOT spawn a fresh pendingAssistant on a
  // thread that already has at least one finalized assistant response —
  // a follow-up turn would have a fresh `clientMessageId` and root its
  // own thread.
  // ---------------------------------------------------------------------------

  it("addUserMessage_does_not_spawn_phantom_pending_on_already_finalized_thread", () => {
    // Q1: user sends, assistant streams, turn finalizes cleanly.
    makeUser("今天北京的天气如何", "cmid-q1");
    ThreadStore.appendAssistantToken("cmid-q1", "北京今天天气晴朗，气温 18.4°C");
    ThreadStore.finalizeAssistant("cmid-q1", { committedSeq: 1 });

    const afterFinalize = ThreadStore.getThreads(SESSION)[0];
    expect(afterFinalize.pendingAssistant).toBeNull();
    expect(afterFinalize.responses).toHaveLength(1);

    // A second `addUserMessage` for the SAME cmid arrives — this is the
    // production trigger (legacy SSE mirror running after the WS path
    // already finalized; retry-path re-publishing the same payload; etc.).
    // The user already saw their answer; this MUST NOT create a fresh
    // streaming pending.
    ThreadStore.addUserMessage(SESSION, {
      text: "今天北京的天气如何",
      clientMessageId: "cmid-q1",
    });

    const after = ThreadStore.getThreads(SESSION)[0];
    expect(
      after.pendingAssistant,
      "second addUserMessage on a finalized thread MUST NOT spawn a phantom streaming bubble — that empty bubble pins isRunning=true and surfaces as the empty-timestamp ghost the user reported on mini1 2026-05-08",
    ).toBeNull();
    expect(after.responses).toHaveLength(1);
    expect(after.responses[0].text).toBe("北京今天天气晴朗，气温 18.4°C");
  });

  // ---------------------------------------------------------------------------
  // PR J Fix 1: Adjacent media-only companion coalescing
  //
  // After reload: assistant text record N (e.g. Chinese-language deep-research
  // report) followed by record N+1 carrying just the report's audio/podcast
  // as files (no new text) renders as ONE bubble — not two duplicate bubbles
  // where the second is empty with just files.
  // ---------------------------------------------------------------------------

  it("replayHistory_merges_adjacent_media_only_companion_into_text_record", () => {
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "深度研究今日中美关系",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "## 深度研究报告\n今日要点……",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 2,
        role: "assistant",
        content: "",
        media: ["/tmp/report.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:06Z",
      },
    ]);

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(
      thread.responses,
      "Chinese report + media-only companion should render as ONE bubble, not two",
    ).toHaveLength(1);
    expect(thread.responses[0].text).toContain("深度研究报告");
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([
      "/tmp/report.mp3",
    ]);
    expect(
      thread.responses[0].historySeq,
      "merged record must keep max(historySeq) so later messages stay ordered",
    ).toBe(2);
  });

  it("replayHistory_merges_companion_with_only_file_marker_text", () => {
    // Companion text contains only a `[file:...]` placeholder line — also
    // counts as media-only since the marker is not user-visible content.
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "make me a podcast",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "Here is your podcast.",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 2,
        role: "assistant",
        content: "[file: podcast.mp3]",
        media: ["/tmp/podcast.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:06Z",
      },
    ]);

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Here is your podcast.");
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([
      "/tmp/podcast.mp3",
    ]);
  });

  it("replayHistory_does_not_merge_when_seq_is_not_adjacent", () => {
    // Gap in seq → not the deep_research-companion pattern, keep separate.
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "Text answer.",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 5,
        role: "assistant",
        content: "",
        media: ["/tmp/standalone.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:30Z",
      },
    ]);

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(
      thread.responses,
      "non-adjacent seq must NOT collapse — that media bubble is from a different background task",
    ).toHaveLength(2);
  });

  it("replayHistory_does_not_merge_across_threads", () => {
    // Companion shape but on a different thread → two threads, no merge.
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "Q1",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "Text answer.",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 2,
        role: "user",
        content: "Q2",
        client_message_id: "cm-2",
        thread_id: "cm-2",
        timestamp: "2026-04-28T10:00:06Z",
      },
      {
        seq: 3,
        role: "assistant",
        content: "",
        media: ["/tmp/cross.mp3"],
        response_to_client_message_id: "cm-2",
        thread_id: "cm-2",
        timestamp: "2026-04-28T10:00:07Z",
      },
    ]);

    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(2);
    expect(threads[0].responses).toHaveLength(1);
    expect(threads[0].responses[0].files).toHaveLength(0);
    expect(threads[1].responses).toHaveLength(1);
    expect(threads[1].responses[0].files.map((f) => f.path)).toEqual([
      "/tmp/cross.mp3",
    ]);
  });

  // ---------------------------------------------------------------------------
  // PR J Fix 2: Sweep still-running tool chips on `done` without `tool_end`
  //
  // If the server emits `done` for an assistant turn without a preceding
  // explicit `tool_end` for some tool calls (suppressed/lost terminal event),
  // the tool chips would otherwise stay visually "running" forever.
  // ---------------------------------------------------------------------------

  it("finalizeAssistant_sweeps_running_tool_calls_to_complete", () => {
    // Use a NON-spawn_only tool name. After codex PR #147 BLOCKER
    // (2026-05-22) the sweep is gated by `SPAWN_ONLY_TOOL_NAMES`, so
    // tools like `run_pipeline` are intentionally left in `running`
    // (their terminal flip comes from `task/updated:completed`, not
    // the turn sweep). A synchronous tool like `read_file` is still
    // swept because the server's `done` is the only terminal signal
    // when an explicit `tool_end` was suppressed.
    makeUser("read a file", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "call_A", "read_file");
    ThreadStore.appendToolProgress("cmid-1", "call_A", "[info] step 1");
    // No tool_end fires — server omits it. `done` arrives.
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 3 });

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant).toBeNull();
    expect(thread.responses).toHaveLength(1);
    const tcs = thread.responses[0].toolCalls;
    expect(tcs).toHaveLength(1);
    expect(
      tcs[0].status,
      "running non-spawn_only tool chip must flip to complete on done — never stay spinning",
    ).toBe("complete");
    expect(tcs[0].id).toBe("call_A");
  });

  it("finalizeAssistant_leaves_running_spawn_only_tool_calls_in_running", () => {
    // codex PR #147 BLOCKER (2026-05-22): the sweep is gated by
    // `SPAWN_ONLY_TOOL_NAMES`. For spawn_only tools the foreground
    // `tool/completed` is just the supervisor's acknowledgement —
    // the background work continues for minutes after the LLM turn
    // ends. Sweeping the chip to `complete` here would silently undo
    // the Defect A deferral. The terminal flip MUST come from
    // `handleTaskUpdated`, not `finalizeAssistant`.
    makeUser("kick off pipeline", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "call_pipe", "run_pipeline");
    ThreadStore.appendToolProgress("cmid-1", "call_pipe", "[info] starting");
    // No tool_end fires (typical for spawn_only — foreground
    // completion would only acknowledge the supervisor handoff).
    // `done` arrives.
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 3 });

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.pendingAssistant).toBeNull();
    expect(thread.responses).toHaveLength(1);
    const tcs = thread.responses[0].toolCalls;
    expect(tcs).toHaveLength(1);
    expect(
      tcs[0].status,
      "spawn_only tool chip MUST stay `running` until task/updated:completed",
    ).toBe("running");
    expect(tcs[0].name).toBe("run_pipeline");
  });

  it("finalizeAssistant_does_not_regress_already_complete_tool_calls", () => {
    makeUser("call_with_proper_tool_end", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "call_A", "run_pipeline");
    ThreadStore.setToolCallStatus("cmid-1", "call_A", "complete");
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 3 });

    const [thread] = ThreadStore.getThreads(SESSION);
    const tcs = thread.responses[0].toolCalls;
    expect(tcs[0].status).toBe("complete");
  });

  it("finalizeAssistant_preserves_error_status_on_tool_calls", () => {
    // Errors must NOT be silently overwritten to "complete" by the sweep —
    // that would hide a user-visible failure.
    makeUser("call_that_failed", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "call_A", "run_pipeline");
    ThreadStore.setToolCallStatus("cmid-1", "call_A", "error");
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 3 });

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses[0].toolCalls[0].status).toBe("error");
  });

  it("finalizeAssistant_sweeps_when_done_arrives_with_no_progress_no_end", () => {
    // Edge case: tool_start fires, but no tool_progress and no tool_end —
    // `done` is the only terminal signal we get. Chip must still complete.
    makeUser("instant tool", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "call_A", "fast_tool");
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 1 });

    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.responses[0].toolCalls[0];
    expect(tc.status).toBe("complete");
    expect(tc.id).toBe("call_A");
  });

  it("finalizeAssistant_sweeps_multiple_running_tool_calls_in_one_turn", () => {
    makeUser("parallel tools", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "call_A", "search");
    ThreadStore.addToolCall("cmid-1", "call_B", "fetch");
    ThreadStore.setToolCallStatus("cmid-1", "call_A", "complete");
    // call_B never gets a tool_end — sweep should clean it up.
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 2 });

    const [thread] = ThreadStore.getThreads(SESSION);
    const tcs = thread.responses[0].toolCalls;
    expect(tcs.find((tc) => tc.id === "call_A")?.status).toBe("complete");
    expect(tcs.find((tc) => tc.id === "call_B")?.status).toBe("complete");
  });

  it("replayHistory_does_not_merge_when_companion_has_text_content", () => {
    // Both records have text → real two-bubble conversation, never merge.
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "First answer.",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 2,
        role: "assistant",
        content: "Follow-up note.",
        media: ["/tmp/extra.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:06Z",
      },
    ]);

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // PR J Fix 3: Media + upload hardening
  //
  // (a) Duplicate assistant+file collapse: same thread, overlapping file
  //     paths, compatible text → ONE bubble after replay.
  // (b) historySeq max preservation across any file-merge operation.
  // (c) User upload combo (image + audio) — both attach to the user bubble.
  // ---------------------------------------------------------------------------

  it("replayHistory_collapses_duplicate_assistant_records_with_overlapping_file", () => {
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "make audio",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "Here is your audio.",
        media: ["/a.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 2,
        role: "assistant",
        content: "Here is your audio.",
        media: ["/a.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:06Z",
      },
    ]);

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].files.map((f) => f.path)).toEqual(["/a.mp3"]);
  });

  it("replayHistory_preserves_max_historySeq_after_duplicate_file_merge", () => {
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 5,
        role: "user",
        content: "Q",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 6,
        role: "assistant",
        content: "Answer with a file.",
        media: ["/a.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 10,
        role: "assistant",
        content: "Answer with a file.",
        media: ["/a.mp3", "/b.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:08Z",
      },
    ]);

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].historySeq).toBe(10);
    // Files unioned, no duplicates.
    expect(thread.responses[0].files.map((f) => f.path).sort()).toEqual([
      "/a.mp3",
      "/b.mp3",
    ]);
  });

  it("replayHistory_does_not_collapse_assistant_records_with_distinct_files", () => {
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "First file.",
        media: ["/a.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 2,
        role: "assistant",
        content: "Second file.",
        media: ["/b.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:08Z",
      },
    ]);

    const [thread] = ThreadStore.getThreads(SESSION);
    // Distinct file paths AND distinct text → two real bubbles, no merge.
    expect(thread.responses).toHaveLength(2);
  });

  it("replayHistory_keeps_max_historySeq_after_media_companion_merge", () => {
    // Re-assert Fix 1's seq invariant using a wider seq gap so the test
    // is decisive: companion at seq 12 must produce a merged bubble whose
    // historySeq is 12, not the prior 11.
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 10,
        role: "user",
        content: "research",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
      },
      {
        seq: 11,
        role: "assistant",
        content: "Report body.",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:05Z",
      },
      {
        seq: 12,
        role: "assistant",
        content: "",
        media: ["/r.mp3"],
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:06Z",
      },
    ]);

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].historySeq).toBe(12);
    expect(thread.responses[0].intra_thread_seq).toBe(12);
  });

  it("user_message_with_image_and_audio_attaches_both_files_to_user_bubble", () => {
    // Issue: image+voice combined upload regressed — only one of the two
    // files attached to the user bubble. Fix is at the `addUserMessage`
    // level — both paths must end up on `userMsg.files`.
    const result = ThreadStore.addUserMessage(SESSION, {
      text: "look at this",
      clientMessageId: "cm-1",
      files: [
        { filename: "photo.png", path: "/uploads/photo.png", caption: "" },
        { filename: "voice.m4a", path: "/uploads/voice.m4a", caption: "" },
      ],
    });
    expect(result.threadId).toBe("cm-1");

    const [thread] = ThreadStore.getThreads(SESSION);
    const paths = thread.userMsg.files.map((f) => f.path);
    expect(
      paths,
      "image+voice upload regression: both files must attach to the user bubble",
    ).toEqual(["/uploads/photo.png", "/uploads/voice.m4a"]);
    expect(thread.userMsg.role).toBe("user");
  });

  it("replayHistory_user_message_with_image_and_audio_preserves_both_files", () => {
    // History reload of an image+voice user turn: both media paths must
    // round-trip onto `thread.userMsg.files`.
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "look at this",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:00Z",
        media: ["/uploads/photo.png", "/uploads/voice.m4a"],
      },
      {
        seq: 1,
        role: "assistant",
        content: "OK",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-04-28T10:00:01Z",
      },
    ]);

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.userMsg.files.map((f) => f.path)).toEqual([
      "/uploads/photo.png",
      "/uploads/voice.m4a",
    ]);
  });

  // -------------------------------------------------------------------------
  // appendPersistedMessage — M8.10 wave-6 leak (PR M, session_result routing)
  // -------------------------------------------------------------------------

  it("appendPersistedMessage_routes_late_assistant_into_existing_thread", () => {
    // Fixture: deep_research turn whose spawn-ack assistant has already
    // finalized. The late session_result carrying the actual report must
    // land in the SAME thread's responses, not a new orphan.
    makeUser("deep research today's news", "cm-deep");
    ThreadStore.replaceAssistantText("cm-deep", "spawned");
    ThreadStore.finalizeAssistant("cm-deep", { committedSeq: 1 });

    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 5,
      role: "assistant",
      content: "## Today\nReport body...",
      response_to_client_message_id: "cm-deep",
      thread_id: "cm-deep",
      timestamp: "2026-04-28T10:05:00Z",
    });

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.id).toBe("cm-deep");
    expect(thread.responses).toHaveLength(2);
    expect(thread.responses[1].text).toContain("Report body");
    expect(thread.responses[1].historySeq).toBe(5);
  });

  it("appendPersistedMessage_with_media_only_companion_appends_separate_bubble", () => {
    // M10 Phase 5b contract change (formerly
    // `appendPersistedMessage_with_media_only_companion_merges_into_text_response`).
    //
    // Pre-M10 behaviour: a media-only persisted row (empty content +
    // file attachments) folded into the prior text bubble via the
    // `isMediaOnlyCompanion` + adjacent-seq splice-merge predicate, so
    // the user saw a single bubble holding both the spoken-text and the
    // delivered file. That predicate produced 5+ waves of bugs (sticky-
    // map drift, phantom-chunk drop, wrong-bubble target) and is gone.
    //
    // M10 contract: each persisted row is its own bubble. The renderer
    // already supports N>=1 assistant bubbles per user prompt. For
    // `spawn_only` completions the new `turn/spawn_complete` envelope
    // (server PR #772) delivers content + media in one atomic event;
    // the per-file companion `message/persisted` rows are filtered
    // server-side under the `event.spawn_complete.v1` capability
    // (PR #773, Phase 5a). Non-spawn flows that produce a media-only
    // companion now append a fresh bubble — visually a second row
    // showing the file, anchored under the same user prompt.
    makeUser("make me a podcast", "cm-pod");
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 1,
      role: "assistant",
      content: "Here is your podcast.",
      response_to_client_message_id: "cm-pod",
      thread_id: "cm-pod",
      timestamp: "2026-04-28T10:00:05Z",
    });
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 2,
      role: "assistant",
      content: "",
      media: ["/tmp/podcast.mp3"],
      response_to_client_message_id: "cm-pod",
      thread_id: "cm-pod",
      timestamp: "2026-04-28T10:00:06Z",
    });

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(2);
    expect(thread.responses[0].text).toBe("Here is your podcast.");
    expect(thread.responses[0].files).toHaveLength(0);
    expect(thread.responses[1].text).toBe("");
    expect(thread.responses[1].files.map((f) => f.path)).toEqual([
      "/tmp/podcast.mp3",
    ]);
  });

  it("appendPersistedMessage_idempotent", () => {
    makeUser("Q", "cm-1");
    const msg = {
      seq: 7,
      role: "assistant" as const,
      content: "Answer.",
      response_to_client_message_id: "cm-1",
      thread_id: "cm-1",
      timestamp: "2026-04-28T10:00:05Z",
    };
    ThreadStore.appendPersistedMessage(SESSION, undefined, msg);
    ThreadStore.appendPersistedMessage(SESSION, undefined, msg);

    const [thread] = ThreadStore.getThreads(SESSION);
    const finalized = thread.responses.filter((r) => r.role === "assistant");
    expect(
      finalized,
      "second call with same seq must be a no-op",
    ).toHaveLength(1);
  });

  it("appendPersistedMessage_seqless_poll_dedupes_against_live_persisted_row", () => {
    // Regression: dspfac reproducer — `task-watcher.ts` polls
    // `session/messages_page` every 2500ms during a long-running
    // `run_pipeline` (deep_research) turn. The server's `MessageInfo`
    // struct strips `seq`/`message_id`, so polled rows arrive with
    // `message.seq === undefined`. Pre-fix the seq-only dedupe always
    // missed and the same persisted row (typically the spawn_only
    // "Background work started for `run_pipeline`..." ack) got
    // appended on every tick — producing the runaway 5+ duplicate
    // bubble pattern. The (role, content, timestamp) fallback
    // identity catches this without needing a server change.
    makeUser("深度研究 ...", "cm-poll");
    const liveRow = {
      seq: 4,
      role: "assistant" as const,
      content: "Background work started for `run_pipeline`. The final result will be delivered automatically when it is ready.",
      response_to_client_message_id: "cm-poll",
      thread_id: "cm-poll",
      timestamp: "2026-04-28T10:00:05Z",
    };
    // 1. live wire row arrives WITH seq
    ThreadStore.appendPersistedMessage(SESSION, undefined, liveRow);
    // 2. polling task-watcher fetches the same row 8 times in 20 seconds,
    // but the server strips seq and message_id from the MessageInfo
    // response — only role/content/timestamp/thread_id survive
    const polledRow = {
      role: "assistant" as const,
      content: liveRow.content,
      thread_id: "cm-poll",
      // PR #149 followup: server's `persisted_at` and the live row's
      // `r.timestamp` (`Date.now()` at append time) NEVER line up
      // exactly. Polled rows on dspfac arrive ~150ms-2s after the
      // live row. Drift the polled timestamp on purpose so the
      // regression test pins the 5-min proximity window, not strict
      // equality.
      timestamp: "2026-04-28T10:00:07Z",
    };
    for (let i = 0; i < 8; i += 1) {
      ThreadStore.appendPersistedMessage(SESSION, undefined, polledRow);
    }

    const [thread] = ThreadStore.getThreads(SESSION);
    const acks = thread.responses.filter((r) =>
      r.text.startsWith("Background work started"),
    );
    expect(
      acks,
      "polled rows within the 5-min proximity window must dedupe even when timestamps drift",
    ).toHaveLength(1);
  });

  // WEB-NEW-17: seq-based dedup across hydration + live events.
  // mini3 repro (2026-05-23): JSONL has 6 unique assistant rows, the
  // SPA renders each one twice — the live `message/persisted` WS event
  // and the `session/messages_page` hydration both reach
  // `appendPersistedMessage` / `replayHistory` without an authoritative
  // cross-path dedup. The per-thread `r.historySeq === incomingSeq`
  // walk misses because `replayHistory` rebuilds the thread state and
  // server's legacy `MessageInfo` strips `seq` from polled rows
  // (handlers.rs:810), so the rebuilt responses lose their seq.
  it("dedups_when_hydration_precedes_live_message_persisted_with_same_seq", () => {
    // Step 1 — hydrate the store from `session/messages_page`. Three
    // unique assistant rows committed under the same user prompt. The
    // hydration path carries `seq` (matching the live wire) so the
    // per-session seenSeqs cache is primed.
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-05-23T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "A1",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-05-23T10:00:01Z",
      },
      {
        seq: 2,
        role: "assistant",
        content: "A2",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-05-23T10:00:02Z",
      },
      {
        seq: 3,
        role: "assistant",
        content: "A3",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-05-23T10:00:03Z",
      },
    ]);

    // Step 2 — the live `message/persisted` WS event re-fires for the
    // same three committed rows (covers the reconnect / hydrate replay
    // case where the daemon re-emits durable rows). Same seqs, same
    // content. Without WEB-NEW-17 each one appends a duplicate bubble.
    for (let i = 1; i <= 3; i += 1) {
      ThreadStore.appendPersistedMessage(SESSION, undefined, {
        seq: i,
        role: "assistant",
        content: `A${i}`,
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        // Drift the timestamp like a re-emission would (Date.now() at
        // append time != server `persisted_at`) so a content+timestamp
        // fallback alone cannot rescue the dedup.
        timestamp: "2026-05-23T10:05:30Z",
      });
    }

    const [thread] = ThreadStore.getThreads(SESSION);
    const assistants = thread.responses.filter((r) => r.role === "assistant");
    expect(
      assistants,
      "hydration-then-live overlap must dedup on seq, not double-render",
    ).toHaveLength(3);
    expect(assistants.map((r) => r.text)).toEqual(["A1", "A2", "A3"]);
  });

  it("dedups_when_live_message_persisted_precedes_hydration_with_same_seq", () => {
    // Inverse path: live wire delivers first (the typical reload-mid-
    // stream scenario), then hydration arrives carrying the same seqs.
    // The store must end with one row per seq.
    makeUser("Q", "cm-1");
    for (let i = 1; i <= 3; i += 1) {
      ThreadStore.appendPersistedMessage(SESSION, undefined, {
        seq: i,
        role: "assistant",
        content: `A${i}`,
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: `2026-05-23T10:00:0${i}Z`,
      });
    }

    // Now `replayHistory` runs (e.g. `loadHistory(..., { force: true })`
    // on a session switch). It wipes `thread.responses` and rebuilds
    // from the JSONL. Without WEB-NEW-17 the live rows survive only as
    // their JSONL siblings — but on the next post-rebuild live event
    // for the same seq, the per-thread walk would miss (the rebuilt
    // rows lost `historySeq` for `messages_page` polls that strip it).
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-05-23T10:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "A1",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-05-23T10:00:01Z",
      },
      {
        seq: 2,
        role: "assistant",
        content: "A2",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-05-23T10:00:02Z",
      },
      {
        seq: 3,
        role: "assistant",
        content: "A3",
        response_to_client_message_id: "cm-1",
        thread_id: "cm-1",
        timestamp: "2026-05-23T10:00:03Z",
      },
    ]);

    // Post-rebuild live re-emit: another live `message/persisted` for
    // an already-seen seq. The seenSeqs cache survives the rebuild and
    // catches it at the gate.
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 2,
      role: "assistant",
      content: "A2",
      response_to_client_message_id: "cm-1",
      thread_id: "cm-1",
      timestamp: "2026-05-23T10:10:00Z",
    });

    const [thread] = ThreadStore.getThreads(SESSION);
    const assistants = thread.responses.filter((r) => r.role === "assistant");
    expect(
      assistants,
      "live-first-then-hydrate overlap must dedup on seq across the rebuild boundary",
    ).toHaveLength(3);
    expect(assistants.map((r) => r.text)).toEqual(["A1", "A2", "A3"]);
  });

  it("clearSession_resets_seenSeqs_so_a_re_streamed_seq_renders_again", () => {
    // Edge case: after a session is cleared (delete or topic flip) the
    // seq cache must NOT persist — a fresh send under the same
    // session/topic with a re-cycled seq must render.
    makeUser("Q", "cm-1");
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 5,
      role: "assistant",
      content: "First answer.",
      response_to_client_message_id: "cm-1",
      thread_id: "cm-1",
      timestamp: "2026-05-23T10:00:00Z",
    });
    ThreadStore.clearSession(SESSION);

    // Fresh send post-clear under a brand-new thread; the same seq
    // value must NOT be suppressed.
    makeUser("Q-new", "cm-2");
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 5,
      role: "assistant",
      content: "Second answer.",
      response_to_client_message_id: "cm-2",
      thread_id: "cm-2",
      timestamp: "2026-05-23T11:00:00Z",
    });

    const threads = ThreadStore.getThreads(SESSION);
    const allAssistantRows = threads.flatMap((t) =>
      t.responses.filter((r) => r.role === "assistant"),
    );
    expect(
      allAssistantRows.map((r) => r.text),
      "clearSession must release the seenSeqs cache",
    ).toEqual(["Second answer."]);
  });

  it("seenSeqs_are_per_session_so_the_same_seq_renders_in_a_different_session", () => {
    // Edge case: seq=N in session A must NOT block seq=N in session B
    // — the cache is keyed per `(sessionId, topic)`.
    const SESS_A = "sess-A";
    const SESS_B = "sess-B";
    ThreadStore.addUserMessage(SESS_A, { text: "QA", clientMessageId: "cm-A" });
    ThreadStore.addUserMessage(SESS_B, { text: "QB", clientMessageId: "cm-B" });

    ThreadStore.appendPersistedMessage(SESS_A, undefined, {
      seq: 7,
      role: "assistant",
      content: "Answer A",
      response_to_client_message_id: "cm-A",
      thread_id: "cm-A",
      timestamp: "2026-05-23T10:00:00Z",
    });
    ThreadStore.appendPersistedMessage(SESS_B, undefined, {
      seq: 7,
      role: "assistant",
      content: "Answer B",
      response_to_client_message_id: "cm-B",
      thread_id: "cm-B",
      timestamp: "2026-05-23T10:00:00Z",
    });

    const [tA] = ThreadStore.getThreads(SESS_A);
    const [tB] = ThreadStore.getThreads(SESS_B);
    expect(tA.responses.filter((r) => r.role === "assistant")).toHaveLength(1);
    expect(tB.responses.filter((r) => r.role === "assistant")).toHaveLength(1);
    expect(tA.responses[0].text).toBe("Answer A");
    expect(tB.responses[0].text).toBe("Answer B");
  });

  it("appendPersistedMessage_falls_back_to_legacy_thread_id_when_thread_id_missing", () => {
    // Legacy daemon: server omits thread_id. Helper must derive it from
    // client_message_id / response_to_client_message_id and find the
    // existing thread anyway.
    makeUser("Q", "cm-legacy");
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 3,
      role: "assistant",
      content: "Late answer.",
      response_to_client_message_id: "cm-legacy",
      timestamp: "2026-04-28T10:00:05Z",
    });

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.id).toBe("cm-legacy");
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Late answer.");
  });

  it("appendPersistedMessage_does_not_disturb_pendingAssistant_for_other_thread", () => {
    // Thread A still streaming, thread B receives a late session_result.
    // A's pendingAssistant must be untouched.
    makeUser("slow Q", "cm-A");
    makeUser("fast Q", "cm-B");
    ThreadStore.appendAssistantToken("cm-A", "still typing");

    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 9,
      role: "assistant",
      content: "B's answer.",
      response_to_client_message_id: "cm-B",
      thread_id: "cm-B",
      timestamp: "2026-04-28T10:00:05Z",
    });

    const threads = ThreadStore.getThreads(SESSION);
    const a = threads.find((t) => t.id === "cm-A")!;
    const b = threads.find((t) => t.id === "cm-B")!;
    expect(a.pendingAssistant?.text).toBe("still typing");
    expect(a.pendingAssistant?.status).toBe("streaming");
    expect(b.responses).toHaveLength(1);
    expect(b.responses[0].text).toBe("B's answer.");
  });

  it("appendPersistedMessage_creates_orphan_thread_when_thread_unknown", () => {
    // Late session_result for a thread we never saw open (e.g. mid-stream
    // page reload). Helper must synthesize a placeholder thread so the
    // record is at least visible — no silent drop.
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 4,
      role: "assistant",
      content: "Orphan late answer.",
      response_to_client_message_id: "cm-unseen",
      thread_id: "cm-unseen",
      timestamp: "2026-04-28T10:00:05Z",
    });

    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("cm-unseen");
    expect(threads[0].responses).toHaveLength(1);
    expect(threads[0].responses[0].text).toBe("Orphan late answer.");
  });

  // -------------------------------------------------------------------------
  // M10 Phase 2: appendCompletionBubble
  // -------------------------------------------------------------------------

  it("appendCompletionBubble_adds_new_row_without_merging_into_pending", () => {
    makeUser("ask", "cmid-c1");
    // pendingAssistant is open (placeholder created by addUserMessage).
    const before = ThreadStore.getThreads(SESSION)[0];
    expect(before.pendingAssistant).not.toBeNull();
    const pendingId = before.pendingAssistant!.id;

    ThreadStore.appendCompletionBubble("cmid-c1", {
      text: "Background result body.",
      media: ["research/out.md"],
      spawnComplete: true,
      historySeq: 7,
      messageId: "msg-bg-1",
    });

    const after = ThreadStore.getThreads(SESSION)[0];
    // The pending assistant MUST stay untouched (it belongs to a
    // different turn — possibly still in flight).
    expect(after.pendingAssistant).not.toBeNull();
    expect(after.pendingAssistant!.id).toBe(pendingId);
    expect(after.pendingAssistant!.text).toBe("");

    expect(after.responses).toHaveLength(1);
    expect(after.responses[0].text).toBe("Background result body.");
    expect(after.responses[0].files.map((f) => f.path)).toEqual([
      "research/out.md",
    ]);
    expect(after.responses[0].historySeq).toBe(7);
    expect(after.responses[0].status).toBe("complete");
    expect(after.responses[0].id).toBe("msg-bg-1");
  });

  it("appendCompletionBubble_does_not_merge_into_existing_finalized_assistant", () => {
    makeUser("ask", "cmid-c2");
    ThreadStore.appendAssistantToken("cmid-c2", "Spawn-ack text.");
    ThreadStore.finalizeAssistant("cmid-c2", { committedSeq: 3 });

    ThreadStore.appendCompletionBubble("cmid-c2", {
      text: "Late result.",
      media: ["a.mp3"],
      spawnComplete: true,
      historySeq: 4,
    });

    const [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(2);
    expect(thread.responses[0].text).toBe("Spawn-ack text.");
    expect(thread.responses[0].files).toHaveLength(0); // not merged
    expect(thread.responses[1].text).toBe("Late result.");
    expect(thread.responses[1].files.map((f) => f.path)).toEqual(["a.mp3"]);
  });

  it("appendCompletionBubble_is_idempotent_on_replay_by_history_seq", () => {
    makeUser("ask", "cmid-c3");
    ThreadStore.finalizeAssistant("cmid-c3");

    const opts = {
      text: "X",
      media: [],
      spawnComplete: true as const,
      historySeq: 99,
      messageId: "msg-idem",
    };
    ThreadStore.appendCompletionBubble("cmid-c3", opts);
    ThreadStore.appendCompletionBubble("cmid-c3", opts);

    const [thread] = ThreadStore.getThreads(SESSION);
    const matches = thread.responses.filter((r) => r.text === "X");
    expect(matches).toHaveLength(1);
  });

  it("appendCompletionBubble_creates_orphan_thread_when_thread_unknown", () => {
    makeUser("seed", "cmid-seed"); // ensures a host session exists
    const ok = ThreadStore.appendCompletionBubble("cmid-late", {
      text: "Late envelope.",
      media: [],
      spawnComplete: true,
      historySeq: 5,
    });
    expect(ok).toBe(true);
    const orphan = ThreadStore.getThreads(SESSION).find(
      (t) => t.id === "cmid-late",
    );
    expect(orphan).toBeDefined();
    expect(orphan?.responses[0].text).toBe("Late envelope.");
  });

  it("appendCompletionBubble_upgrades_empty_persisted_row_with_matching_seq", () => {
    // Codex P2 rollout-edge case: if `message/persisted` for a spawn row
    // arrives before `turn/spawn_complete` (server suppression slip,
    // replay ordering), `appendPersistedMessage` lands an empty-content
    // placeholder under the same `historySeq`. The spawn envelope MUST
    // upgrade the existing row in place rather than be skipped as a
    // duplicate, otherwise the user sees a blank bubble.
    makeUser("ask", "cmid-c-upgrade");
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 14,
      role: "assistant",
      content: "", // metadata-only persisted row
      thread_id: "cmid-c-upgrade",
      response_to_client_message_id: "cmid-c-upgrade",
      timestamp: "2026-04-30T00:00:00Z",
      media: [],
    });
    let [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("");

    ThreadStore.appendCompletionBubble("cmid-c-upgrade", {
      text: "Real spawn result.",
      media: ["bg/out.md"],
      spawnComplete: true,
      historySeq: 14,
      messageId: "msg-upgrade",
    });
    [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Real spawn result.");
    expect(thread.responses[0].files.map((f) => f.path)).toEqual(["bg/out.md"]);
    expect(thread.responses[0].historySeq).toBe(14);
  });

  it("appendCompletionBubble_upgrades_media_bearing_persisted_placeholder", () => {
    // Codex round-3 P2: `message/persisted` for a spawn row CAN carry
    // media (P1.3 server PR #767). When that row arrives first, the
    // placeholder has empty text but non-empty files. The spawn envelope
    // must still upgrade the row (filling text + merging media) rather
    // than treating it as a duplicate, otherwise the user sees a
    // file-only bubble with no body text.
    makeUser("ask", "cmid-c-merge");
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 21,
      role: "assistant",
      content: "",
      thread_id: "cmid-c-merge",
      response_to_client_message_id: "cmid-c-merge",
      timestamp: "2026-04-30T00:00:00Z",
      media: ["bg/early.md"],
    });
    let [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses[0].text).toBe("");
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([
      "bg/early.md",
    ]);

    ThreadStore.appendCompletionBubble("cmid-c-merge", {
      text: "Real result body.",
      media: ["bg/early.md", "bg/late.md"],
      spawnComplete: true,
      historySeq: 21,
    });
    [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Real result body.");
    // Files unioned by path — early.md is not duplicated.
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([
      "bg/early.md",
      "bg/late.md",
    ]);
  });

  it("appendCompletionBubble_does_not_upgrade_already_full_row_on_replay", () => {
    // Defensive symmetry to the upgrade-in-place case: when the existing
    // row at the matching seq already has full content (true replay
    // scenario), the second call must be a no-op. Otherwise a reconnect
    // could overwrite a finalized row with stale data from the wire.
    makeUser("ask", "cmid-c-replay");
    ThreadStore.appendCompletionBubble("cmid-c-replay", {
      text: "First.",
      media: ["a.md"],
      spawnComplete: true,
      historySeq: 7,
      messageId: "m1",
    });
    ThreadStore.appendCompletionBubble("cmid-c-replay", {
      text: "Different (stale).",
      media: ["a.md"],
      spawnComplete: true,
      historySeq: 7,
      messageId: "m1",
    });
    const [thread] = ThreadStore.getThreads(SESSION);
    const matches = thread.responses.filter((r) => r.historySeq === 7);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("First.");
  });

  it("appendCompletionBubble_appends_when_seq_was_donated_by_replayHistory_companion_merge", () => {
    // Codex round-5 P2: legacy `replayHistory` (via
    // `mergeMediaCompanionInto`) MOVES a media-only companion's
    // `historySeq` onto the preceding non-empty ack bubble. After that,
    // the spawn-complete envelope replaying with the same seq must NOT
    // be silently dropped — the row at that seq is now the ack bubble,
    // not the completion. Append a fresh row instead.
    makeUser("ask", "cmid-c-merged-seq");
    // Simulate `replayHistory`'s post-merge state: a non-empty ack
    // bubble that has been donated the spawn-complete's seq.
    ThreadStore.replayHistory(SESSION, [
      {
        role: "user",
        content: "ask",
        thread_id: "cmid-c-merged-seq",
        client_message_id: "cmid-c-merged-seq",
        seq: 0,
        timestamp: "2026-04-30T00:00:00Z",
      },
      {
        role: "assistant",
        content: "Background work started.",
        thread_id: "cmid-c-merged-seq",
        response_to_client_message_id: "cmid-c-merged-seq",
        seq: 1,
        timestamp: "2026-04-30T00:00:01Z",
      },
      {
        // Media-only companion — replayHistory will fold this into the
        // ack bubble and donate seq=2 to it.
        role: "assistant",
        content: "",
        thread_id: "cmid-c-merged-seq",
        response_to_client_message_id: "cmid-c-merged-seq",
        seq: 2,
        timestamp: "2026-04-30T00:00:02Z",
        media: ["bg/_report.md"],
      },
    ]);
    let [thread] = ThreadStore.getThreads(SESSION);
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Background work started.");
    // The merge donated seq=2 onto the ack bubble.
    expect(thread.responses[0].historySeq).toBe(2);

    // Now the live spawn-complete envelope replays with seq=2.
    ThreadStore.appendCompletionBubble("cmid-c-merged-seq", {
      text: "Real research result.",
      media: ["bg/_report.md"],
      spawnComplete: true,
      historySeq: 2,
      messageId: "msg-spawn-replay",
    });

    [thread] = ThreadStore.getThreads(SESSION);
    // CRITICAL: a NEW row appears for the spawn completion. The ack
    // bubble's text is preserved.
    expect(thread.responses).toHaveLength(2);
    expect(thread.responses[0].text).toBe("Background work started.");
    expect(
      thread.responses.some((r) => r.text === "Real research result."),
    ).toBe(true);
  });

  it("appendCompletionBubble_dedupes_by_messageId_when_present", () => {
    // Codex round-5: the strongest dedupe identity is the server-side
    // `message_id` (Phase 1 P2-B fix reuses the persisted row's id on
    // the spawn envelope). Two calls with the same messageId must
    // collapse to a single row even if seq differs (e.g. cursor-vs-row
    // seq confusion).
    makeUser("ask", "cmid-c-msgid");
    ThreadStore.appendCompletionBubble("cmid-c-msgid", {
      text: "Result.",
      media: [],
      spawnComplete: true,
      messageId: "msg-stable",
      historySeq: 5,
    });
    ThreadStore.appendCompletionBubble("cmid-c-msgid", {
      text: "Result.",
      media: [],
      spawnComplete: true,
      messageId: "msg-stable",
      historySeq: 5,
    });
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(
      thread.responses.filter((r) => r.id === "msg-stable"),
    ).toHaveLength(1);
  });

  it("appendCompletionBubble_uses_server_persistedAt_for_display_timestamp", () => {
    // Codex round-4 P3: row timestamp must be the server's
    // `persisted_at`, not client receipt time, so reconnect/replay
    // produces a stable display order matching hydrated history.
    makeUser("ask", "cmid-c-ts");
    ThreadStore.appendCompletionBubble("cmid-c-ts", {
      text: "Body.",
      media: [],
      spawnComplete: true,
      historySeq: 50,
      persistedAt: "2026-04-30T10:11:12.000Z",
    });
    const [thread] = ThreadStore.getThreads(SESSION);
    const completion = thread.responses.find((r) => r.text === "Body.");
    expect(completion?.timestamp).toBe(
      new Date("2026-04-30T10:11:12.000Z").getTime(),
    );
  });

  it("appendCompletionBubble_returns_false_when_no_session_exists", () => {
    // No makeUser — no host session has been created yet, so
    // ensureOrphanThread has nowhere to host the row.
    const ok = ThreadStore.appendCompletionBubble("cmid-nowhere", {
      text: "Nowhere.",
      media: [],
      spawnComplete: true,
    });
    expect(ok).toBe(false);
  });

  it("appendCompletionBubble_routes_burst_of_3_sibling_envelopes_to_distinct_threads", () => {
    // M10 follow-up Bug B regression: under the wave-6m soak, 3+
    // sibling user prompts (each with a spawn_only skill) sometimes
    // fail to receive their `turn/spawn_complete` envelope when the
    // envelopes arrive in rapid succession (parallel deep_search +
    // mofa-podcast + tts can finish back-to-back).
    //
    // The synchronous routing path MUST land each envelope under its
    // own user-prompt thread, regardless of dispatch order. Each thread
    // has a finalized spawn-ack (the "Q1/Q2/Q3 user bubble + spawn-ack"
    // shape from the failing soak DOM dump) so the upgrade-in-place
    // codepath is NOT triggered — fresh rows are appended.
    makeUser("Q1 deep research", "cmid-Q1");
    makeUser("Q2 mofa podcast", "cmid-Q2");
    makeUser("Q3 tts", "cmid-Q3");

    // Each thread already has a finalized spawn-ack (mirrors the live
    // sequence: spawn_only tool emits message/delta + message/persisted
    // for the ack BEFORE the late spawn_complete envelope).
    ThreadStore.appendAssistantToken("cmid-Q1", "深度研究已在后台启动…");
    ThreadStore.finalizeAssistant("cmid-Q1", { committedSeq: 2 });
    ThreadStore.appendAssistantToken("cmid-Q2", "Podcast generation started…");
    ThreadStore.finalizeAssistant("cmid-Q2", { committedSeq: 3 });
    ThreadStore.appendAssistantToken("cmid-Q3", "TTS synthesis started…");
    ThreadStore.finalizeAssistant("cmid-Q3", { committedSeq: 4 });

    // 3 turn/spawn_complete envelopes fire in the same JS tick (server
    // emitted them within ms of each other; the WS frame loop drains
    // them all before yielding). Each carries DISTINCT messageId,
    // historySeq, and threadId.
    ThreadStore.appendCompletionBubble("cmid-Q1", {
      text: "Rust news: tokio 1.42 released.",
      media: ["bg/research-Q1.md"],
      spawnComplete: true,
      messageId: "msg-Q1-result",
      historySeq: 10,
      sessionId: SESSION,
    });
    ThreadStore.appendCompletionBubble("cmid-Q2", {
      text: "AI podcast episode generated.",
      media: ["bg/podcast-Q2.mp3"],
      spawnComplete: true,
      messageId: "msg-Q2-result",
      historySeq: 11,
      sessionId: SESSION,
    });
    ThreadStore.appendCompletionBubble("cmid-Q3", {
      text: "Voice synthesised.",
      media: ["bg/tts-Q3.mp3"],
      spawnComplete: true,
      messageId: "msg-Q3-result",
      historySeq: 12,
      sessionId: SESSION,
    });

    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.map((t) => t.id)).toEqual([
      "cmid-Q1",
      "cmid-Q2",
      "cmid-Q3",
    ]);

    const findCompletion = (threadId: string) =>
      threads
        .find((t) => t.id === threadId)
        ?.responses.find((r) => r.id.startsWith("msg-"));

    const c1 = findCompletion("cmid-Q1");
    const c2 = findCompletion("cmid-Q2");
    const c3 = findCompletion("cmid-Q3");
    expect(c1?.text).toBe("Rust news: tokio 1.42 released.");
    expect(c1?.files.map((f) => f.path)).toEqual(["bg/research-Q1.md"]);
    expect(c2?.text).toBe("AI podcast episode generated.");
    expect(c2?.files.map((f) => f.path)).toEqual(["bg/podcast-Q2.mp3"]);
    expect(c3?.text).toBe("Voice synthesised.");
    expect(c3?.files.map((f) => f.path)).toEqual(["bg/tts-Q3.mp3"]);

    // Each thread MUST have exactly its own ack + completion (2 rows),
    // not bleed into siblings — the splice-merge bug class M10 deletes.
    for (const t of threads) {
      expect(t.responses).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// M10 Phase 6.2 (Bug C): WS session/hydrate dedup pass
// ---------------------------------------------------------------------------

describe.each(FLAG_STATES)(
  "applyHydrateDedup (M10 Phase 6.2) [$label]",
  ({ projectionV1 }) => {
    beforeEach(() => {
      __setProjectionV1ForTests(projectionV1);
    });
  const SID = "sess-bug-c";

  it("drops the legacy spawn-ack row when an envelope's message_id matches it, then renders the envelope", () => {
    // Replay the REST history shape the server returns post-Bug-C
    // before client-side dedup: user prompt + spawn-ack assistant row
    // (background source) + per-file companion row (background
    // source). The live wire suppressed both for negotiated clients
    // and replaced them with one `turn/spawn_complete` envelope.
    ThreadStore.replayHistory(SID, [
      {
        seq: 0,
        role: "user",
        content: "Use deep_search to research X.",
        client_message_id: "cmid-user-1",
        thread_id: "cmid-user-1",
        timestamp: "2026-05-04T00:00:00Z",
      },
      {
        seq: 19,
        role: "assistant",
        content: "Done.",
        thread_id: "cmid-user-1",
        timestamp: "2026-05-04T00:09:22.538Z",
      },
      {
        seq: 20,
        role: "assistant",
        content: "",
        thread_id: "cmid-user-1",
        timestamp: "2026-05-04T00:09:22.541Z",
        media: ["pf/_report.md"],
      },
    ]);

    // Pre-dedup: the legacy adjacent-merge already coalesces the
    // companion (seq=20) into the spawn-ack (seq=19) since they have
    // adjacent seqs and the companion has empty text. So the thread
    // ends up with 1 user + 1 ack-with-file response. We still need
    // dedup to replace that ack with the envelope content.
    const before = ThreadStore.getThreads(SID);
    expect(before).toHaveLength(1);
    const beforeResponses = before[0].responses.length;
    expect(beforeResponses).toBeGreaterThanOrEqual(1);

    // Apply hydrate dedup with the WS envelope that replaces the ack.
    // Per the server's hydrate contract: the envelope's `message_id`
    // matches the spawn-ack row (seq=19); the companion row (seq=20)
    // is identified by media-subset match against the envelope's
    // `media` array.
    ThreadStore.applyHydrateDedup(SID, undefined, {
      messages: [
        {
          seq: 0,
          message_id: "local:demo:0:1",
          source: "user",
          thread_id: "cmid-user-1",
        },
        {
          seq: 19,
          message_id: "local:demo:19:19",
          source: "background",
          thread_id: "cmid-user-1",
        },
        {
          seq: 20,
          message_id: "local:demo:20:20",
          source: "background",
          thread_id: "cmid-user-1",
          media: ["pf/_report.md"],
        },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-user-1",
          task_id: "task_abc",
          seq: 19,
          message_id: "local:demo:19:19",
          content: "## Research delivered\nFull text inline.",
          media: ["pf/_report.md"],
          persisted_at: "2026-05-04T00:09:22.538Z",
        },
      ],
    });

    const after = ThreadStore.getThreads(SID);
    expect(after).toHaveLength(1);
    const responses = after[0].responses;
    // Exactly 1 assistant bubble (the envelope's content), not 2 (ack + envelope).
    expect(responses).toHaveLength(1);
    // The bubble's content comes from the envelope, not the ack.
    expect(responses[0].text).toBe("## Research delivered\nFull text inline.");
    expect(responses[0].files.map((f) => f.path)).toContain("pf/_report.md");
  });

  it("drops file-companion rows whose media is a subset of the envelope's media", () => {
    // Production shape: the spawn-ack row at seq=N (text, no media)
    // followed by per-file `send_file` companion rows at seq=N+1...
    // (each carrying ONE media file). The envelope's `media` array
    // aggregates every companion's file path, so a media-subset
    // match identifies the per-file companions for safe deletion.
    ThreadStore.__resetForTests();
    ThreadStore.replayHistory(SID, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:00Z",
      },
      {
        seq: 10,
        role: "assistant",
        content: "spawn ack",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:03Z",
      },
      // Per-file companions — gaps with the spawn-ack so
      // adjacent-merge does not coalesce them.
      {
        seq: 13,
        role: "assistant",
        content: "",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:04Z",
        media: ["bg/file-a.md"],
      },
      {
        seq: 16,
        role: "assistant",
        content: "",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:05Z",
        media: ["bg/file-b.md"],
      },
    ]);

    const before = ThreadStore.getThreads(SID);
    expect(before[0].responses).toHaveLength(3);

    ThreadStore.applyHydrateDedup(SID, undefined, {
      messages: [
        { seq: 0, message_id: "m0", source: "user", thread_id: "cmid-1" },
        // Spawn-ack: matches envelope's message_id.
        { seq: 10, message_id: "m10", source: "background", thread_id: "cmid-1" },
        // Per-file companions: identified by media-subset against envelope.media.
        {
          seq: 13,
          message_id: "m13",
          source: "background",
          thread_id: "cmid-1",
          media: ["bg/file-a.md"],
        },
        {
          seq: 16,
          message_id: "m16",
          source: "background",
          thread_id: "cmid-1",
          media: ["bg/file-b.md"],
        },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-1",
          task_id: "task_x",
          seq: 10,
          message_id: "m10",
          content: "envelope content",
          media: ["bg/file-a.md", "bg/file-b.md"],
          persisted_at: "2026-05-04T00:00:03Z",
        },
      ],
    });

    const after = ThreadStore.getThreads(SID);
    // 3 background rows: spawn-ack matches by message_id, both
    // per-file companions match by media-subset. All dropped, then
    // envelope appended as 1 fresh bubble.
    expect(after[0].responses).toHaveLength(1);
    expect(after[0].responses[0].text).toBe("envelope content");
    expect(after[0].responses[0].files.map((f) => f.path).sort()).toEqual([
      "bg/file-a.md",
      "bg/file-b.md",
    ]);
  });

  it("preserves a background row whose media is NOT a subset of the envelope's media (different completion)", () => {
    // Edge case: a separate spawn_only completion's row whose
    // envelope aged out of the retention window. We must NOT drop
    // it just because it sits in the same anchor as a known
    // envelope (codex round 3 P2). Delete-only-when-positive-evidence.
    ThreadStore.__resetForTests();
    ThreadStore.replayHistory(SID, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:00Z",
      },
      {
        seq: 10,
        role: "assistant",
        content: "spawn ack A",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:03Z",
      },
      // A background row whose media doesn't appear in the envelope:
      // belongs to a separate completion. Server retention window may
      // have aged out its envelope. MUST NOT drop.
      {
        seq: 30,
        role: "assistant",
        content: "",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:10Z",
        media: ["bg/orphan.md"],
      },
    ]);

    ThreadStore.applyHydrateDedup(SID, undefined, {
      messages: [
        { seq: 0, message_id: "m0", source: "user", thread_id: "cmid-1" },
        { seq: 10, message_id: "m10", source: "background", thread_id: "cmid-1" },
        {
          seq: 30,
          message_id: "m30",
          source: "background",
          thread_id: "cmid-1",
          media: ["bg/orphan.md"],
        },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-1",
          task_id: "task_a",
          seq: 10,
          message_id: "m10",
          content: "completion A",
          media: [], // no companions covered by this envelope
          persisted_at: "2026-05-04T00:00:03Z",
        },
      ],
    });

    const after = ThreadStore.getThreads(SID)[0].responses;
    // Spawn-ack A dropped (message_id match); orphan row preserved
    // (media-subset miss); envelope appended.
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.text === "completion A")).toBeDefined();
    expect(
      after.find((r) => r.files.some((f) => f.path === "bg/orphan.md")),
    ).toBeDefined();
  });

  it("is a no-op without replayed_envelopes (older server / non-negotiated client)", () => {
    ThreadStore.__resetForTests();
    ThreadStore.replayHistory(SID, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:00Z",
      },
      {
        seq: 1,
        role: "assistant",
        content: "A",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:01Z",
      },
    ]);
    const beforeIds = ThreadStore.getThreads(SID)[0].responses.map((r) => r.id);

    ThreadStore.applyHydrateDedup(SID, undefined, {
      messages: undefined,
      replayed_envelopes: undefined,
    });

    const after = ThreadStore.getThreads(SID);
    expect(after[0].responses).toHaveLength(1);
    expect(after[0].responses.map((r) => r.id)).toEqual(beforeIds);
  });

  it("dedups by message_id even when the hydrated row omits thread_id (legacy row)", () => {
    // Codex round-4 P2: legacy ledger rows can omit `thread_id` while
    // still exposing the post-#791 stable `message_id`. The dedup
    // pass MUST honour the message_id match without an anchor lookup,
    // otherwise reloads of legacy sessions keep the spawn-ack
    // duplicate.
    ThreadStore.__resetForTests();
    ThreadStore.replayHistory(SID, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:00Z",
      },
      {
        seq: 5,
        role: "assistant",
        content: "spawn ack",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:01Z",
      },
    ]);

    ThreadStore.applyHydrateDedup(SID, undefined, {
      messages: [
        {
          seq: 0,
          message_id: "m0",
          source: "user",
          // No thread_id — legacy row.
        },
        {
          seq: 5,
          message_id: "m5",
          source: "background",
          // No thread_id — legacy row.
        },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-1",
          task_id: "task_legacy",
          seq: 5,
          message_id: "m5",
          content: "envelope replaces ack",
          media: [],
          persisted_at: "2026-05-04T00:00:01Z",
        },
      ],
    });

    const after = ThreadStore.getThreads(SID)[0].responses;
    // Spawn-ack dropped via session-wide message_id match; envelope appended.
    expect(after).toHaveLength(1);
    expect(after[0].text).toBe("envelope replaces ack");
  });

  it("does not cross-cover companions of different turns sharing a media path", () => {
    // Codex round-6 P2: two completions in the same anchor thread
    // that emit the same media path must not pollute each other's
    // dedup. Bound media-subset matching to the same turn_id when
    // both sides expose it.
    ThreadStore.__resetForTests();
    ThreadStore.replayHistory(SID, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:00Z",
      },
      // Completion A's spawn-ack.
      {
        seq: 5,
        role: "assistant",
        content: "ack A",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:01Z",
      },
      // Completion B's companion (different turn) reuses the same path.
      {
        seq: 8,
        role: "assistant",
        content: "",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:02Z",
        media: ["bg/shared.md"],
      },
    ]);

    ThreadStore.applyHydrateDedup(SID, undefined, {
      messages: [
        { seq: 0, message_id: "m0", source: "user", thread_id: "cmid-1" },
        {
          seq: 5,
          message_id: "m5",
          source: "background",
          thread_id: "cmid-1",
          turn_id: "turn-A",
        },
        {
          seq: 8,
          message_id: "m8",
          source: "background",
          thread_id: "cmid-1",
          turn_id: "turn-B",
          media: ["bg/shared.md"],
        },
      ],
      replayed_envelopes: [
        // Only completion A's envelope is retained; B's aged out.
        {
          thread_id: "cmid-1",
          turn_id: "turn-A",
          task_id: "task_A",
          seq: 5,
          message_id: "m5",
          content: "envelope A",
          media: ["bg/shared.md"], // shares path with B's companion
          persisted_at: "2026-05-04T00:00:01Z",
        },
      ],
    });

    const after = ThreadStore.getThreads(SID)[0].responses;
    // Completion A's ack dropped via message_id match; B's companion
    // PRESERVED (turn_id mismatch on media-subset path); envelope appended.
    const texts = after.map((r) => r.text);
    expect(texts).toContain("envelope A");
    // B's companion bubble is still rendered (media-bearing,
    // empty-text — visible via attachment).
    expect(
      after.some((r) => r.files.some((f) => f.path === "bg/shared.md") && r.text === ""),
    ).toBe(true);
  });

  it("preserves non-background rows even when their seq overlaps the envelope's anchor", () => {
    // A user-source row at seq=0 must NOT be dropped just because it
    // precedes the envelope's seq in the same anchor. The (b) branch
    // is gated on `source === "background"`.
    ThreadStore.__resetForTests();
    ThreadStore.replayHistory(SID, [
      {
        seq: 0,
        role: "user",
        content: "Q",
        client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:00Z",
      },
      {
        seq: 5,
        role: "assistant",
        content: "regular assistant reply",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:01Z",
      },
      {
        seq: 10,
        role: "assistant",
        content: "spawn ack",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:02Z",
      },
    ]);

    ThreadStore.applyHydrateDedup(SID, undefined, {
      messages: [
        { seq: 0, message_id: "m0", source: "user", thread_id: "cmid-1" },
        // Non-background — protected from dedup even though it precedes the envelope.
        { seq: 5, message_id: "m5", source: "assistant", thread_id: "cmid-1" },
        { seq: 10, message_id: "m10", source: "background", thread_id: "cmid-1" },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-1",
          task_id: "task_y",
          seq: 10,
          message_id: "m10",
          content: "envelope final",
          media: [],
          persisted_at: "2026-05-04T00:00:02Z",
        },
      ],
    });

    const after = ThreadStore.getThreads(SID)[0].responses;
    // Regular assistant reply preserved; spawn-ack replaced by envelope.
    expect(after.map((r) => r.text)).toEqual([
      "regular assistant reply",
      "envelope final",
    ]);
  });
  },
);

describe.each(FLAG_STATES)(
  "setHydrateSnapshot reload-mid-stream fallback (M10.5) [$label]",
  ({ projectionV1 }) => {
    beforeEach(() => {
      __setProjectionV1ForTests(projectionV1);
    });
  const SID = "sess-reload-mid-stream";

  /**
   * The brief's hardening test (`m10-harden-reload-midstream.spec.ts`)
   * lives behind `OCTOS_LIVE_PROBE=1` and exercises a real WS reload.
   * This unit test pins the data shape the SPA must produce for that
   * scenario — when REST `loadHistory` returned `[]` (e.g. server
   * returned the wrong session-key path before the M10.5 server fix
   * landed) but WS `session/hydrate` carried the canonical
   * `messages[]` plus a retained `replayed_envelopes[]` for the
   * completion. Pre-fix the SPA only emitted the envelope as an
   * orphan completion bubble; the user prompt + ack + narration rows
   * were silently dropped.
   */
  it("seeds the store from hydrate.messages when REST returned [] and the envelope upgrades the spawn-ack in place", () => {
    // Note: REST loadHistory was NOT called — `sessionsByKey` is
    // empty for this session. This is the post-M10.5-server-fix
    // race where REST hasn't run yet OR the REST proxy returned `[]`
    // for the WS-key-mismatch case the server PR closes.
    ThreadStore.setHydrateSnapshot(SID, undefined, {
      messages: [
        {
          seq: 0,
          role: "user",
          content: "tell me the weather in NYC",
          client_message_id: "cmid-user-1",
          thread_id: "cmid-user-1",
          persisted_at: "2026-05-04T00:00:00Z",
        },
        {
          seq: 1,
          role: "assistant",
          content: "Looking up the latest forecast.",
          thread_id: "cmid-user-1",
          persisted_at: "2026-05-04T00:00:01Z",
        },
        {
          // The spawn-ack the envelope upgrades. Marked `background`
          // so the dedup pass either drops it (covered) or
          // `appendCompletionBubble` upgrades it via `historySeq`
          // match (this row is the placeholder shape with no media).
          seq: 19,
          message_id: "local:weather:19",
          source: "background",
          role: "assistant",
          content: "",
          thread_id: "cmid-user-1",
          persisted_at: "2026-05-04T00:00:02Z",
        },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-user-1",
          task_id: "task_weather",
          seq: 19,
          message_id: "local:weather:19",
          content: "## NYC weather\nSunny, 72°F.",
          media: [],
          persisted_at: "2026-05-04T00:00:02Z",
        },
      ],
    });

    // Result must be: 1 user thread + 2 assistant responses
    //   • "Looking up the latest forecast." (the narration row)
    //   • "## NYC weather\nSunny, 72°F."  (the envelope, upgrading
    //     the spawn-ack in place, NOT a sibling orphan bubble)
    const threads = ThreadStore.getThreads(SID);
    expect(threads).toHaveLength(1);
    expect(threads[0].userMsg.text).toBe("tell me the weather in NYC");
    expect(threads[0].userMsg.clientMessageId).toBe("cmid-user-1");
    const responseTexts = threads[0].responses.map((r) => r.text);
    expect(responseTexts).toContain("Looking up the latest forecast.");
    expect(responseTexts).toContain("## NYC weather\nSunny, 72°F.");
    // Exactly 2 assistant responses — the narration + the envelope's
    // upgraded completion. NOT 3 (narration + ack + envelope), which
    // would be the post-seed-but-pre-upgrade shape, and NOT 1 (just
    // the envelope), which would be the pre-fix orphan shape.
    expect(threads[0].responses).toHaveLength(2);
    // Critically: NOT a sibling orphan thread with empty user bubble.
    // Pre-fix the store ended up with 2 threads — one empty
    // placeholder hosting the envelope.
    for (const t of threads) {
      expect(t.userMsg.text).not.toBe("");
    }
  });

  /**
   * Confirm the seed is idempotent: a subsequent `replayHistory` call
   * (REST retries fire at 2s/5s/12s) replaces state wholesale, so a
   * real REST response that lands later WINS for any overlap with the
   * hydrate seed. Pre-fix this was already true for a non-empty REST
   * response; this test pins the post-fix invariant that even when
   * REST is `[]` the seed is preserved (not wiped) until a non-empty
   * REST result arrives.
   */
  it("preserves the hydrate seed when a subsequent REST loadHistory returns []", () => {
    ThreadStore.setHydrateSnapshot(SID, undefined, {
      messages: [
        {
          seq: 0,
          role: "user",
          content: "hello",
          client_message_id: "cmid-1",
          thread_id: "cmid-1",
          persisted_at: "2026-05-04T00:00:00Z",
        },
        {
          seq: 1,
          role: "assistant",
          content: "hi back",
          thread_id: "cmid-1",
          persisted_at: "2026-05-04T00:00:01Z",
        },
      ],
      replayed_envelopes: [],
    });

    // Pre-condition: hydrate seed populated the store.
    expect(ThreadStore.getThreads(SID)).toHaveLength(1);

    // REST replay returns []. Pre-M10.5-fix server, this is exactly
    // what the SPA saw on reload-mid-stream. `replayHistory` MUST
    // re-apply the cached hydrate so the user prompt stays visible.
    ThreadStore.replayHistory(SID, []);

    const threads = ThreadStore.getThreads(SID);
    expect(threads).toHaveLength(1);
    expect(threads[0].userMsg.text).toBe("hello");
  });

  /**
   * Codex SPA round 1 P2.1: when `hydrate.messages` carries only
   * system rows (older daemons emit a system bootstrap on every
   * session), `replayHistory` skips them and leaves the store empty.
   * Pre-P2-fix `setHydrateSnapshot` would re-invoke
   * `applyHydrateDedup` from `replayHistory`'s cached-hydrate hook,
   * which would call `seedFromHydrateMessages` again on the still-
   * empty store — infinite recursion until the call stack overflows.
   * Post-fix: system rows are filtered before deciding to seed, so
   * the seed pass is a no-op (no recursion).
   */
  it("does not recurse when hydrate.messages carries only system rows", () => {
    expect(() => {
      ThreadStore.setHydrateSnapshot(SID, undefined, {
        messages: [
          {
            seq: 0,
            role: "system",
            content: "session bootstrap",
            persisted_at: "2026-05-04T00:00:00Z",
          },
          {
            seq: 1,
            role: "system",
            content: "system policy",
            persisted_at: "2026-05-04T00:00:01Z",
          },
        ],
        replayed_envelopes: [],
      });
    }).not.toThrow();
    // No threads created — system rows are not user-rooted.
    expect(ThreadStore.getThreads(SID)).toHaveLength(0);
  });

  /**
   * Codex SPA round 2 P2: a hydrate with non-system but assistant/
   * tool-only rows would produce orphan-placeholder threads (empty
   * user bubble) via `replayHistory`. Pre-fix the cached-hydrate
   * re-apply hook would then call `applyHydrateDedup` again, which
   * re-entered `seedFromHydrateMessages` (the placeholder threads
   * matched `allThreadsAreOrphanPlaceholders`) and infinite-looped.
   * Post-fix: require at least one user row before seeding.
   */
  it("does not recurse when hydrate.messages has no user row", () => {
    expect(() => {
      ThreadStore.setHydrateSnapshot(SID, undefined, {
        messages: [
          {
            seq: 0,
            role: "assistant",
            content: "stale assistant rumination",
            thread_id: "cmid-orphan",
            persisted_at: "2026-05-04T00:00:00Z",
          },
          {
            seq: 1,
            role: "tool",
            content: "tool result",
            thread_id: "cmid-orphan",
            persisted_at: "2026-05-04T00:00:01Z",
          },
        ],
        replayed_envelopes: [],
      });
    }).not.toThrow();
    // No threads created — without a user row the seed is a no-op
    // (we'd rather show nothing than orphan-place an unrooted history).
    expect(ThreadStore.getThreads(SID)).toHaveLength(0);
  });

  /**
   * Codex SPA round 1 P2.2: when an envelope is delivered BEFORE the
   * `session/hydrate` response (live wire ordering), the store
   * already holds an orphan-placeholder thread with an empty user
   * bubble. The seed pass MUST treat that state as still-seedable so
   * the canonical hydrate history (real user prompt + narration)
   * replaces the placeholder. Pre-fix the placeholder was treated as
   * authoritative and the user prompt was never restored.
   */
  it("seeds over orphan placeholders created by an early envelope", () => {
    // Simulate envelope-before-hydrate ordering: a
    // `turn/spawn_complete` lands before `session/hydrate` returns.
    // `appendCompletionBubble` creates an orphan-placeholder thread
    // (empty user bubble) hosting the envelope's content.
    ThreadStore.appendCompletionBubble("cmid-user-1", {
      text: "## Research delivered\nFull text inline.",
      media: [],
      spawnComplete: true,
      sourceClientMessageId: "cmid-user-1",
      sessionId: SID,
    });

    const beforeSeed = ThreadStore.getThreads(SID);
    expect(beforeSeed).toHaveLength(1);
    expect(beforeSeed[0].userMsg.text).toBe("");

    // Now hydrate lands with the canonical history (REST is still []).
    ThreadStore.setHydrateSnapshot(SID, undefined, {
      messages: [
        {
          seq: 0,
          role: "user",
          content: "do the research",
          client_message_id: "cmid-user-1",
          thread_id: "cmid-user-1",
          persisted_at: "2026-05-04T00:00:00Z",
        },
        {
          seq: 1,
          role: "assistant",
          content: "spawning the deep_research task",
          thread_id: "cmid-user-1",
          persisted_at: "2026-05-04T00:00:01Z",
        },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-user-1",
          task_id: "task_research",
          seq: 19,
          message_id: "local:research:19",
          content: "## Research delivered\nFull text inline.",
          media: [],
          persisted_at: "2026-05-04T00:00:02Z",
        },
      ],
    });

    const afterSeed = ThreadStore.getThreads(SID);
    expect(afterSeed).toHaveLength(1);
    expect(afterSeed[0].userMsg.text).toBe("do the research");
    expect(afterSeed[0].userMsg.clientMessageId).toBe("cmid-user-1");
    // Both the narration AND the envelope's completion are reachable.
    const responseTexts = afterSeed[0].responses.map((r) => r.text);
    expect(responseTexts).toContain("spawning the deep_research task");
    expect(responseTexts).toContain("## Research delivered\nFull text inline.");
  });

  /**
   * Symmetrical guard for the happy path: a real REST response with
   * authoritative rows must win over the hydrate seed. Ensures the
   * fallback never silently overrides REST data.
   */
  it("REST loadHistory wins over hydrate seed for any overlap", () => {
    ThreadStore.setHydrateSnapshot(SID, undefined, {
      messages: [
        {
          seq: 0,
          role: "user",
          content: "stale hydrate user",
          client_message_id: "cmid-1",
          thread_id: "cmid-1",
          persisted_at: "2026-05-04T00:00:00Z",
        },
      ],
      replayed_envelopes: [],
    });

    // REST returns the authoritative shape — text differs from the
    // hydrate seed (e.g. user edited their prompt before the server
    // commit landed).
    ThreadStore.replayHistory(SID, [
      {
        seq: 0,
        role: "user",
        content: "AUTHORITATIVE rest user text",
        client_message_id: "cmid-1",
        thread_id: "cmid-1",
        timestamp: "2026-05-04T00:00:00Z",
      },
    ]);

    const threads = ThreadStore.getThreads(SID);
    expect(threads).toHaveLength(1);
    expect(threads[0].userMsg.text).toBe("AUTHORITATIVE rest user text");
  });

  /**
   * M10.5 reload-mid-stream regression (the bug
   * `tests/m10-harden-reload-midstream.spec.ts` catches): when the
   * server returns a hydrate carrying BOTH the legacy `Background`-source
   * companion row in `messages[]` AND the `turn/spawn_complete` envelope
   * in `replayed_envelopes[]` (with the same media), the SPA must not
   * render the companion as a separate bubble.
   *
   * Pre-fix: `seedFromHydrateMessages` fed the companion verbatim into
   * `replayHistory`, producing 1 user + 3 assistant (ack + companion +
   * envelope-completion). Post-fix: the seed pass drops covered
   * background rows BEFORE feeding `replayHistory`, leaving 1 user + 2
   * assistant (ack + envelope-completion).
   */
  it("drops covered background companion rows from the seed feed when an envelope covers them", () => {
    ThreadStore.setHydrateSnapshot(SID, undefined, {
      messages: [
        {
          seq: 0,
          role: "user",
          content: "Use deep_research to find news about Rust.",
          client_message_id: "cmid-user-1",
          thread_id: "cmid-user-1",
          persisted_at: "2026-05-04T00:00:00Z",
        },
        {
          // Spawn-ack — background source, no media. NOT covered by
          // the envelope (envelope's message_id is the completion's,
          // not the ack's), so MUST survive the seed.
          seq: 19,
          message_id: "local:research:ack:19",
          source: "background",
          role: "assistant",
          content: "Spawning deep_research…",
          thread_id: "cmid-user-1",
          persisted_at: "2026-05-04T00:00:01Z",
        },
        {
          // Per-file companion — background source, with media. Covered
          // by the envelope's media-subset → MUST be dropped from the
          // seed feed so the dedup pass + envelope-emit don't end up
          // rendering both the companion and the completion.
          seq: 22,
          message_id: "local:research:companion:22",
          source: "background",
          role: "assistant",
          content: "",
          thread_id: "cmid-user-1",
          media: ["pf/rust-news.md"],
          persisted_at: "2026-05-04T00:00:02Z",
        },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-user-1",
          task_id: "task_research",
          seq: 25,
          message_id: "local:research:complete:25",
          content: "## Rust news\nFull report inline.",
          media: ["pf/rust-news.md"],
          persisted_at: "2026-05-04T00:00:03Z",
        },
      ],
    });

    const threads = ThreadStore.getThreads(SID);
    expect(threads).toHaveLength(1);
    expect(threads[0].userMsg.text).toBe(
      "Use deep_research to find news about Rust.",
    );
    // Exactly 2 assistant responses: the spawn-ack (preserved because
    // its message_id does NOT match the envelope and it has no media)
    // and the envelope's completion bubble. The covered background
    // companion was filtered before the seed reached `replayHistory`.
    expect(threads[0].responses).toHaveLength(2);
    const responseTexts = threads[0].responses.map((r) => r.text);
    expect(responseTexts).toContain("Spawning deep_research…");
    expect(responseTexts).toContain("## Rust news\nFull report inline.");
    // The completion bubble carries the media (the companion's path
    // surfaces here once, not twice).
    const fileBubbles = threads[0].responses.filter((r) => r.files.length > 0);
    expect(fileBubbles).toHaveLength(1);
    expect(fileBubbles[0].files.map((f) => f.path)).toEqual(["pf/rust-news.md"]);
  });

  /**
   * Adjacent-seq case: when the spawn-ack and the per-file companion
   * sit at adjacent seqs (N, N+1), pre-fix `replayHistory` would
   * `mergeMediaCompanionInto` and donate the companion's `historySeq`
   * onto the ack — leaving the dedup loop downstream to drop the
   * merged ack (defensive check passes because `meta.source ===
   * "background"`), and then `appendCompletionBubble` appends the
   * envelope as a fresh bubble. The shape WAS 1 user + 1 envelope
   * (the ack lost), which loses the spawn-ack visibility too.
   * Post-fix: covered companion rows are filtered before the merge,
   * so the ack survives intact and the envelope is its sibling.
   */
  it("preserves the spawn-ack when companion at adjacent seq is covered by envelope", () => {
    ThreadStore.setHydrateSnapshot(SID, undefined, {
      messages: [
        {
          seq: 0,
          role: "user",
          content: "Q",
          client_message_id: "cmid-1",
          thread_id: "cmid-1",
          persisted_at: "2026-05-04T00:00:00Z",
        },
        {
          // Spawn-ack at adjacent seq.
          seq: 19,
          message_id: "local:ack:19",
          source: "background",
          role: "assistant",
          content: "Spawning…",
          thread_id: "cmid-1",
          persisted_at: "2026-05-04T00:00:01Z",
        },
        {
          // Companion at the immediately-next seq — pre-fix this
          // adjacency triggered `mergeMediaCompanionInto` and the
          // ack lost its `historySeq` to the companion.
          seq: 20,
          message_id: "local:companion:20",
          source: "background",
          role: "assistant",
          content: "",
          thread_id: "cmid-1",
          media: ["pf/report.md"],
          persisted_at: "2026-05-04T00:00:02Z",
        },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-1",
          task_id: "task_x",
          seq: 25,
          message_id: "local:complete:25",
          content: "## Result\nDone.",
          media: ["pf/report.md"],
          persisted_at: "2026-05-04T00:00:03Z",
        },
      ],
    });

    const threads = ThreadStore.getThreads(SID);
    expect(threads).toHaveLength(1);
    const responseTexts = threads[0].responses.map((r) => r.text);
    // Both the spawn-ack and the envelope's completion are visible
    // (the ack is NOT consumed by an adjacent-seq merge with a row
    // that should never have been seeded in the first place).
    expect(responseTexts).toContain("Spawning…");
    expect(responseTexts).toContain("## Result\nDone.");
    expect(threads[0].responses).toHaveLength(2);
  });

  /**
   * Guard: a background row whose media does NOT match any envelope
   * (separate completion whose envelope aged out of the retention
   * window) MUST survive the seed. Delete-only-when-positive-evidence,
   * mirroring the dedup pass's rule.
   */
  it("preserves background rows whose media is NOT covered by any envelope", () => {
    ThreadStore.setHydrateSnapshot(SID, undefined, {
      messages: [
        {
          seq: 0,
          role: "user",
          content: "Q",
          client_message_id: "cmid-1",
          thread_id: "cmid-1",
          persisted_at: "2026-05-04T00:00:00Z",
        },
        {
          seq: 30,
          message_id: "local:other:30",
          source: "background",
          role: "assistant",
          content: "",
          thread_id: "cmid-1",
          media: ["pf/orphan.md"],
          persisted_at: "2026-05-04T00:00:01Z",
        },
      ],
      replayed_envelopes: [
        {
          thread_id: "cmid-1",
          task_id: "task_a",
          seq: 19,
          message_id: "local:a:19",
          content: "envelope A",
          media: ["pf/different.md"],
          persisted_at: "2026-05-04T00:00:02Z",
        },
      ],
    });

    const threads = ThreadStore.getThreads(SID);
    // Both the surviving companion AND the envelope's completion are
    // present (the orphan companion is preserved because no envelope
    // covers its media).
    const allFiles = threads[0].responses.flatMap((r) =>
      r.files.map((f) => f.path),
    );
    expect(allFiles).toContain("pf/orphan.md");
    expect(allFiles).toContain("pf/different.md");
  });
  },
);

// ---------------------------------------------------------------------------
// M9-γ-3 (issue #840): projection-mode-only behaviour.
//
// These tests run ONLY with `octos_projection_v1 === "1"` and exercise
// the scenarios the legacy reducer handles imperfectly. Each one
// asserts on `getProjection(...)` (the pure-function view computed from
// the committed envelope log), NOT on `getThreads(...)` (the legacy
// state). The projection-only invariants verified here are the ones
// γ-5 will inherit when the legacy reducer is retired.
// ---------------------------------------------------------------------------

describe("ThreadStore projection-mode (M9-γ-3, octos#840)", () => {
  const SID = "sess-projection";

  beforeEach(() => {
    __setProjectionV1ForTests(true);
  });

  it("phantom_bubble_repro_two_assistant_persisted_envelopes_at_seq_1_and_3_accumulate_without_phantom", () => {
    // The 2026-05-09 production phantom-bubble pattern: two
    // `assistant_persisted` events for the same thread land at seq 0
    // and seq 2 (an interleaving tool_progress at seq 1 in between).
    // Legacy `appendCompletionBubble` could spawn a phantom row at
    // seq=0 and then a SECOND row at seq=2 because the historySeq
    // dedup path fell through under specific media-merge donations.
    // Under gap-buffer projection semantics, both seqs apply in
    // canonical order; `assistant_persisted` REPLACES the assistant
    // text/meta in-place, so seq=2 (the canonical replay) wins.
    ThreadStore.addUserMessage(SID, {
      text: "research X",
      clientMessageId: "cmid-1",
    });
    const key = projectionStoreKey(SID);

    // Inject the two persisted envelopes directly through the
    // projection-store so we control the exact `seq` values. We use
    // `projectionIngest` rather than the legacy entry points so the
    // test pins the projection's own dedup contract — independent of
    // what the legacy reducer would have done.
    projectionIngest(key, {
      thread_id: "cmid-1",
      seq: 0,
      payload: {
        type: "assistant_persisted",
        data: {
          text: "first persisted",
          meta: {
            message_id: "msg-1",
            persisted_at: "2026-05-09T10:00:01Z",
          },
        },
      },
    });
    projectionIngest(key, {
      thread_id: "cmid-1",
      seq: 1,
      payload: { type: "assistant_delta", data: { text: " (drift)" } },
    });
    projectionIngest(key, {
      thread_id: "cmid-1",
      seq: 2,
      payload: {
        type: "assistant_persisted",
        data: {
          text: "second persisted (canonical)",
          meta: {
            message_id: "msg-3",
            persisted_at: "2026-05-09T10:00:03Z",
          },
        },
      },
    });

    const view = getProjection(key);
    // Exactly ONE thread, one assistant slot — no phantom row.
    expect(view.threads).toHaveLength(1);
    const thread = view.threads[0];
    expect(thread.thread_id).toBe("cmid-1");
    expect(thread.assistant?.persisted).toBe(true);
    // Last persisted wins (canonical text).
    expect(thread.assistant?.text).toBe("second persisted (canonical)");
    expect(thread.assistant?.meta?.message_id).toBe("msg-3");
  });

  it("late_tool_progress_after_turn_completed_is_dropped_by_projection_hard_barrier", () => {
    // Legacy `appendToolProgress` would re-open a `pendingAssistant`
    // for a finalized thread (the spawn_only late-progress path); the
    // projection's hard barrier on `turn_completed` drops the event
    // and bumps `metrics.droppedAfterTurnCompleted` instead.
    ThreadStore.addUserMessage(SID, {
      text: "run pipeline",
      clientMessageId: "cmid-1",
    });
    ThreadStore.addToolCall("cmid-1", "tc-1", "deep_research");
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 5 });

    // After finalize → projection saw `turn_completed`. Late progress
    // arrives for the same thread.
    ThreadStore.appendToolProgress("cmid-1", "tc-1", "[late] still working");

    const key = projectionStoreKey(SID);
    const { view, metrics } = getProjectionWithMetrics(key);
    const thread = view.threads.find((t) => t.thread_id === "cmid-1");
    expect(thread?.completed).toBe(true);
    // The late `tool_progress` envelope was emitted by the shim AND
    // ingested into the log, BUT the projection's barrier dropped
    // it — so the tool's `progress` array does NOT contain the late
    // message.
    const toolCall = thread?.toolCalls.find((tc) => tc.tool_call_id === "tc-1");
    expect(toolCall?.progress).not.toContain("[late] still working");
    // The projection counter records the drop.
    expect(metrics.droppedAfterTurnCompleted).toBeGreaterThanOrEqual(1);
  });

  it("out_of_order_delivery_seq_2_then_seq_1_is_buffered_and_drained_in_canonical_order", () => {
    // Inject envelopes in `seq=2, seq=1, seq=0` reverse order. Under
    // γ-2's gap-buffer semantics, out-of-order envelopes are BUFFERED
    // (not dropped) until the gap closes, then drained in canonical
    // seq order. `metrics.outOfOrder` counts buffered-then-drained
    // envelopes (back-compat name; not lost). The accumulated
    // assistant text reflects canonical seq order: "zeroth firstthird"
    // wait no — seqs 0,1,2 have text "zeroth", "first", "second"
    // applied in that order, concatenated.
    const key = projectionStoreKey(SID);
    ThreadStore.addUserMessage(SID, {
      text: "out of order",
      clientMessageId: "cmid-1",
    });
    projectionIngest(key, {
      thread_id: "cmid-1",
      seq: 2,
      payload: { type: "assistant_delta", data: { text: "second" } },
    });
    projectionIngest(key, {
      thread_id: "cmid-1",
      seq: 1,
      payload: { type: "assistant_delta", data: { text: "first" } },
    });
    projectionIngest(key, {
      thread_id: "cmid-1",
      seq: 0,
      payload: { type: "assistant_delta", data: { text: "zeroth" } },
    });
    const { view, metrics } = getProjectionWithMetrics(key);
    // Two envelopes (seq=2, seq=1) were buffered; seq=0 closed the
    // gap and drained both. The counter is back-compat-named
    // `outOfOrder`.
    expect(metrics.outOfOrder).toBeGreaterThanOrEqual(2);
    expect(metrics.duplicates).toBe(0);
    const thread = view.threads.find((t) => t.thread_id === "cmid-1");
    // Canonical-order concatenation: 0 → "zeroth", 1 → "first",
    // 2 → "second" — gap-buffer drains them in seq order regardless
    // of arrival order.
    expect(thread?.assistant?.text).toBe("zeroth" + "first" + "second");
  });

  it("cross_session_orphan_envelope_for_unknown_thread_is_appended_no_orphan_bucket_needed", () => {
    // Legacy `findThreadById`/`ensureOrphanThread` allocates a
    // placeholder bucket when a `tool_progress` arrives for an
    // unknown thread. The projection just appends the envelope and
    // the projected view exposes the orphan thread as its own row —
    // no host-session-picking heuristic, no placeholder allocation.
    const key = projectionStoreKey(SID);
    projectionIngest(key, {
      thread_id: "cmid-orphan",
      seq: 0,
      payload: {
        type: "tool_progress",
        data: { tool_call_id: "tc-orphan", message: "orphan log line" },
      },
    });
    const view = getProjection(key);
    const orphan = view.threads.find((t) => t.thread_id === "cmid-orphan");
    expect(orphan).toBeDefined();
    // The projection opens a tool-call card with empty `name` (per
    // γ-2's "progress without a prior start" path) — exactly the
    // shape γ-5's render layer keys off.
    const tc = orphan?.toolCalls.find((tc) => tc.tool_call_id === "tc-orphan");
    expect(tc).toBeDefined();
    expect(tc?.progress).toContain("orphan log line");
  });

  it("identity_collapse_client_message_id_is_captured_on_envelope_but_projection_keys_on_seq", () => {
    // The brief: an envelope's `client_message_id` field is captured
    // but only used for the optimistic overlay (γ-4); the projection
    // itself ignores it for identity. We verify both halves:
    //
    //   (1) The envelope log carries `client_message_id` on the
    //       first envelope for a thread (γ-4's GhostBubble overlay
    //       reads this).
    //   (2) The projection's `(thread_id, seq)` dedup is unaffected
    //       by `client_message_id`: two envelopes that share
    //       `(thread_id, seq)` BUT differ on `client_message_id` are
    //       still treated as duplicates (the second one is dropped).
    ThreadStore.addUserMessage(SID, {
      text: "identity collapse",
      clientMessageId: "cmid-collapse",
    });
    const key = projectionStoreKey(SID);
    // The shim should have associated `cmid-collapse` with the next
    // envelope this thread emits. Trigger one by streaming a token.
    ThreadStore.appendAssistantToken("cmid-collapse", "hi");

    const log = getEnvelopes(key);
    const firstForThread = log.find(
      (e) => e.thread_id === "cmid-collapse",
    );
    expect(firstForThread).toBeDefined();
    expect(firstForThread?.client_message_id).toBe("cmid-collapse");

    // Now deliberately re-ingest the same `(thread_id, seq)` with a
    // DIFFERENT `client_message_id` — the projection's idempotency
    // guard drops it; `client_message_id` plays no role in identity.
    const dupSeq = firstForThread!.seq;
    projectionIngest(key, {
      thread_id: "cmid-collapse",
      seq: dupSeq,
      client_message_id: "cmid-NOT-the-same",
      payload: { type: "assistant_delta", data: { text: " stray" } },
    });
    const { metrics } = getProjectionWithMetrics(key);
    expect(metrics.duplicates).toBeGreaterThanOrEqual(1);
    // The projection's user view still carries the ORIGINAL cmid
    // (set on first-seen envelope) — not the duplicate's cmid.
    const view = getProjection(key);
    const thread = view.threads.find((t) => t.thread_id === "cmid-collapse");
    expect(thread?.user?.client_message_id).toBe("cmid-collapse");
  });

  it("shim_synthesizes_per_thread_monotonic_seqs_so_re_projection_is_deterministic", () => {
    // Constraint from the brief: shim seq synthesis must be
    // per-thread monotonic (NOT `Date.now()`) so that re-projecting
    // the committed log is deterministic. Under gap-buffer projection
    // semantics, the shim mints non-negative seqs starting at 0 to
    // match `expectedNextSeq=0` initialization.
    ThreadStore.addUserMessage(SID, { text: "Q1", clientMessageId: "cm-1" });
    ThreadStore.addUserMessage(SID, { text: "Q2", clientMessageId: "cm-2" });
    ThreadStore.appendAssistantToken("cm-1", "A1.1");
    ThreadStore.appendAssistantToken("cm-2", "A2.1");
    ThreadStore.appendAssistantToken("cm-1", "A1.2");
    ThreadStore.appendAssistantToken("cm-2", "A2.2");

    const key = projectionStoreKey(SID);
    const log = getEnvelopes(key);
    // Group by thread_id and verify monotonicity.
    const byThread = new Map<string, number[]>();
    for (const env of log) {
      const arr = byThread.get(env.thread_id) ?? [];
      arr.push(env.seq);
      byThread.set(env.thread_id, arr);
    }
    for (const seqs of byThread.values()) {
      // Shim mints non-negative seqs so the gap-buffer projection's
      // expectedNextSeq=0 initialization fits the first arrival.
      for (const s of seqs) expect(s).toBeGreaterThanOrEqual(0);
      // Strictly increasing per-thread.
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    }
    // Cross-thread independence: cm-1 and cm-2 each start their own
    // counter — neither one's seqs are functions of the other's.
    expect(byThread.get("cm-1")?.[0]).toBe(byThread.get("cm-2")?.[0]);
  });

  // ── codex round-1 BLOCK 1: synthetic / server seq namespaces ──────────

  it("streamed_delta_then_persisted_envelope_apply_in_canonical_seq_order_under_gap_buffer", () => {
    // Under gap-buffer semantics, the shim mints a non-negative
    // synthetic seq for the streamed delta (seq=0) and a subsequent
    // server-issued `assistant_persisted` carries the next seq (seq=1
    // here). Both apply in canonical order; the persisted payload
    // REPLACES the assistant text/meta in place, so the persisted
    // canonical text wins.
    ThreadStore.addUserMessage(SID, {
      text: "stream then persist",
      clientMessageId: "cmid-1",
    });

    // Synthetic delta — shim mints seq=0.
    ThreadStore.appendAssistantToken("cmid-1", "streamed");

    // Server-issued persisted envelope with seq=1 (next after the
    // synthetic delta). The gap-buffer applies it in order.
    const key = projectionStoreKey(SID);
    projectionIngest(key, {
      thread_id: "cmid-1",
      seq: 1,
      payload: {
        type: "assistant_persisted",
        data: {
          text: "persisted-canonical",
          meta: {
            message_id: "msg-server-1",
            persisted_at: "2026-05-09T11:00:01Z",
          },
        },
      },
    });

    const { view, metrics } = getProjectionWithMetrics(key);
    // Both applied in order — neither dropped as a duplicate.
    expect(metrics.duplicates).toBe(0);
    const thread = view.threads.find((t) => t.thread_id === "cmid-1");
    // The persisted text wins (assistant_persisted REPLACES text).
    expect(thread?.assistant?.persisted).toBe(true);
    expect(thread?.assistant?.text).toBe("persisted-canonical");
  });

  it("late_arriving_envelope_with_seq_below_high_water_buffers_then_drains_under_gap_buffer", () => {
    // Under the canonical gap-buffer projection (γ-2 fixup), an
    // envelope arriving with `seq < expectedNextSeq` is BUFFERED for
    // a possible canonical replay rather than dropped. The shim mints
    // non-negative monotonic seqs so a streamed delta and a
    // subsequent late-fill on a lower seq are reconciled by the
    // projection's drain logic.
    ThreadStore.addUserMessage(SID, {
      text: "interleaved arrivals",
      clientMessageId: "cmid-1",
    });

    // Two streamed tokens through the shim — synthetic seqs 0, 1.
    ThreadStore.appendAssistantToken("cmid-1", "a");
    ThreadStore.appendAssistantToken("cmid-1", "b");

    // A late-arriving envelope at seq=3 (gap above expected=2). The
    // gap-buffer holds it pending. seq=3 contributes a tool_start.
    const key = projectionStoreKey(SID);
    projectionIngest(key, {
      thread_id: "cmid-1",
      seq: 3,
      payload: {
        type: "tool_start",
        data: { tool_call_id: "tc-srv", name: "external_tool" },
      },
    });
    // seq=2 closes the gap; seq=3 drains immediately after.
    projectionIngest(key, {
      thread_id: "cmid-1",
      seq: 2,
      payload: { type: "assistant_delta", data: { text: "c" } },
    });

    const { view, metrics } = getProjectionWithMetrics(key);
    // seq=3 was buffered then drained; counted in `outOfOrder`
    // (back-compat name for buffered-then-applied).
    expect(metrics.outOfOrder).toBeGreaterThanOrEqual(1);
    expect(metrics.duplicates).toBe(0);
    const thread = view.threads.find((t) => t.thread_id === "cmid-1");
    expect(
      thread?.toolCalls.find((tc) => tc.tool_call_id === "tc-srv"),
    ).toBeDefined();
    expect(thread?.assistant?.text).toBe("abc");
  });

  // ── codex round-1 BLOCK 2: retry-collapse emits tool_start ────────────

  it("addToolCall_retry_collapse_emits_tool_start_for_new_tool_call_id", () => {
    // The retry-collapse path mutates the existing legacy tool entry
    // (incrementing retryCount) and returns early. Pre-fix, no
    // `tool_start` envelope was emitted for the NEW tool_call_id, so
    // the projection's tool card was either keyed on the OLD id (if
    // legacy reused it via mutation) or never opened — and any
    // subsequent `tool_progress` for the new id would synthesise an
    // empty-name card. Post-fix: the retry-collapse path emits a
    // fresh `tool_start { tool_call_id: NEW, name }` envelope so the
    // projection opens a properly-named card under the new id.
    ThreadStore.addUserMessage(SID, {
      text: "retry me",
      clientMessageId: "cmid-1",
    });
    ThreadStore.addToolCall("cmid-1", "tc-1", "fetch_thing");
    ThreadStore.setToolCallStatus("cmid-1", "tc-1", "error");
    // The retry: same name, NEW id. Legacy collapses; projection
    // must still see a `tool_start` for tc-2.
    ThreadStore.addToolCall("cmid-1", "tc-2", "fetch_thing");

    const key = projectionStoreKey(SID);
    const log = getEnvelopes(key);
    const startsForTc2 = log.filter(
      (e) =>
        e.payload.type === "tool_start" &&
        e.payload.data.tool_call_id === "tc-2",
    );
    expect(startsForTc2).toHaveLength(1);
    expect(
      startsForTc2[0].payload.type === "tool_start" &&
        startsForTc2[0].payload.data.name,
    ).toBe("fetch_thing");

    // And the projected view: tc-2 has a card with the right name.
    const view = getProjection(key);
    const thread = view.threads.find((t) => t.thread_id === "cmid-1");
    const tc2 = thread?.toolCalls.find((tc) => tc.tool_call_id === "tc-2");
    expect(tc2).toBeDefined();
    expect(tc2?.name).toBe("fetch_thing");
  });

  // ── codex round-1 BLOCK 3: finalizeAssistant emits tool_end on sweep ──

  it("finalizeAssistant_emits_tool_end_for_swept_running_tool_calls_before_turn_completed", () => {
    // Legacy `finalizeAssistant` sweeps any tool calls still in
    // `"running"` to `"complete"` (the wire never delivered a
    // `tool_end` for them). Pre-fix, the projection's tool card
    // stayed in `status: null` because no `tool_end` envelope was
    // emitted, AND the subsequent `turn_completed` envelope's hard
    // barrier meant a late tool_end on the wire could never close
    // the card. Post-fix: finalize emits a synthetic `tool_end`
    // BEFORE `turn_completed` for every swept call.
    ThreadStore.addUserMessage(SID, {
      text: "run pipeline",
      clientMessageId: "cmid-1",
    });
    ThreadStore.addToolCall("cmid-1", "tc-A", "step_one");
    ThreadStore.addToolCall("cmid-1", "tc-B", "step_two");
    // tc-B finishes explicitly via tool_end; tc-A is left running.
    ThreadStore.setToolCallStatus("cmid-1", "tc-B", "complete");
    // Now finalize — the sweep should close tc-A in the projection.
    ThreadStore.finalizeAssistant("cmid-1", { committedSeq: 7 });

    const key = projectionStoreKey(SID);
    const log = getEnvelopes(key);

    // Find the indices of tool_end events for tc-A and the
    // turn_completed event — the tool_end MUST come first.
    const tcAEndIdx = log.findIndex(
      (e) =>
        e.payload.type === "tool_end" &&
        e.payload.data.tool_call_id === "tc-A",
    );
    const turnCompletedIdx = log.findIndex(
      (e) => e.payload.type === "turn_completed",
    );
    expect(tcAEndIdx).toBeGreaterThanOrEqual(0);
    expect(turnCompletedIdx).toBeGreaterThanOrEqual(0);
    expect(tcAEndIdx).toBeLessThan(turnCompletedIdx);

    // And the projected view: tc-A is closed with status=complete.
    const view = getProjection(key);
    const thread = view.threads.find((t) => t.thread_id === "cmid-1");
    const tcA = thread?.toolCalls.find((tc) => tc.tool_call_id === "tc-A");
    expect(tcA?.status).toBe("complete");
    expect(thread?.completed).toBe(true);
  });

  // ── codex round-1 BLOCK 5: mid-session flag flip is ignored ───────────

  it("mid_session_projection_v1_flag_flip_is_ignored_until_reload", () => {
    // The flag is read once and cached on first call; a subsequent
    // localStorage flip is logged as a one-shot warning and
    // otherwise ignored — pre-fix, flipping the flag mid-session
    // would start the projection log from the next shimmed event
    // with no prior envelope history, leaving the projection in an
    // inconsistent state.
    //
    // First read latches the cache at "true" (from the suite's
    // `beforeEach`). Now flip localStorage to "0" WITHOUT calling
    // `__setProjectionV1ForTests` (the test helper resets the
    // cache); the cached value should win.
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      // Prime the cache by issuing a mutation under projectionV1=true.
      ThreadStore.addUserMessage(SID, {
        text: "first",
        clientMessageId: "cm-1",
      });
      ThreadStore.appendAssistantToken("cm-1", "hello");

      const key = projectionStoreKey(SID);
      expect(getEnvelopes(key).length).toBeGreaterThan(0);
      const beforeFlipCount = getEnvelopes(key).length;

      // Flip the raw flag bypassing the test helper.
      globalThis.localStorage?.removeItem("octos_projection_v1");

      // Subsequent mutation should STILL emit envelopes (the cached
      // value wins), AND a single console.warn should fire.
      ThreadStore.appendAssistantToken("cm-1", " world");
      const afterFlipCount = getEnvelopes(key).length;
      expect(afterFlipCount).toBeGreaterThan(beforeFlipCount);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/octos_projection_v1/);

      // Multiple subsequent mutations DO NOT spam the warning —
      // it's a one-shot.
      ThreadStore.appendAssistantToken("cm-1", "!");
      ThreadStore.appendAssistantToken("cm-1", "?");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
