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
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as ThreadStore from "./thread-store";

afterEach(() => {
  ThreadStore.__resetForTests();
  vi.unstubAllGlobals();
});

const SESSION = "sess-test";

function makeUser(text: string, cmid: string) {
  return ThreadStore.addUserMessage(SESSION, {
    text,
    clientMessageId: cmid,
  });
}

describe("thread-store", () => {
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

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = typeof url === "string" ? url : url.toString();
      expect(path).toContain(
        `/api/sessions/${encodeURIComponent(SESSION)}/messages`,
      );
      return new Response(JSON.stringify(messages), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await ThreadStore.loadHistory(SESSION);
    expect(fetchMock).toHaveBeenCalledTimes(1);

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
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // `force: true` bypasses the cache so the mount-effect retry can recover
    // from server persistence latency that returned a partial first fetch.
    await ThreadStore.loadHistory(SESSION, undefined, { force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(messages), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

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
    makeUser("kick off pipeline", "cmid-1");
    ThreadStore.addToolCall("cmid-1", "call_A", "run_pipeline");
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
      "running tool chip must flip to complete on done — never stay spinning",
    ).toBe("complete");
    expect(tcs[0].id).toBe("call_A");
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

  it("appendPersistedMessage_with_media_only_companion_merges_into_text_response", () => {
    // Late media-only delivery (e.g. podcast.mp3) must fold into the
    // previous text response on the same thread — same rule replayHistory
    // applies on a fresh page load.
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
    expect(thread.responses).toHaveLength(1);
    expect(thread.responses[0].text).toBe("Here is your podcast.");
    expect(thread.responses[0].files.map((f) => f.path)).toEqual([
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
});
