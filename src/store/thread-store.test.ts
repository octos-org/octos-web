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
});
