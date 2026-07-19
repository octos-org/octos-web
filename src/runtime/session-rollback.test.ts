/**
 * session-rollback applier tests.
 *
 * Normal path: a SURGICAL suffix trim (`dropLastUserTurnThreads`) that
 * keeps surviving thread objects — and their tool cards / progress /
 * meta — intact. Only a local-vs-server count mismatch falls back to an
 * exact-scope clear + reseed from the returned trimmed projection.
 * Rollbacks are relative, so a per-scope lock refuses concurrent runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ThreadStore from "@/store/thread-store";
import * as ProjectionStore from "@/store/projection-store";
import type { SessionRollbackResult } from "./ui-protocol-types";

const rollbackSession = vi.fn();
const hydrateSession = vi.fn();
vi.mock("./ui-protocol-runtime", () => ({
  getActiveBridge: () => mockBridge,
}));
// The round-7 placeholder-refetch nudge drives ThreadStore.loadHistory →
// getMessagesPage. Default: reject (loadHistory swallows), so gate-closed
// tests stay inert; the nudge liveness test resolves it with history.
const getMessagesPage = vi.fn();
vi.mock("@/api/sessions", () => ({
  getMessagesPage: (...args: unknown[]) => getMessagesPage(...args),
}));
// Reassigned per-test; `null` simulates a disconnected scope.
let mockBridge: {
  rollbackSession: typeof rollbackSession;
  hydrateSession?: typeof hydrateSession;
} | null = {
  rollbackSession,
};

import { rollbackSessionTurns } from "./session-rollback";

const SESSION = "sess-rollback-applier";

function trimmedResult(): SessionRollbackResult {
  return {
    dropped_turns: 1,
    thread: {
      session_id: SESSION,
      cursor: { stream: SESSION, seq: 2 },
      messages: [
        {
          seq: 1,
          role: "user",
          content: "keep me",
          client_message_id: "cmid-keep",
          message_id: "m1",
          persisted_at: "2026-07-10T00:00:00Z",
        },
        {
          seq: 2,
          role: "assistant",
          content: "kept reply",
          message_id: "m2",
          persisted_at: "2026-07-10T00:00:01Z",
        },
      ],
    },
  };
}

beforeEach(() => {
  mockBridge = { rollbackSession };
  rollbackSession.mockReset();
  hydrateSession.mockReset();
  getMessagesPage.mockReset();
  getMessagesPage.mockRejectedValue(new Error("no fetch in test"));
});

afterEach(() => {
  ThreadStore.__resetForTests();
  ProjectionStore.__resetProjectionForTests();
});

describe("rollbackSessionTurns", () => {
  it("replaces the canonical v2 snapshot without mutating the legacy fallback", async () => {
    const key = ProjectionStore.projectionStoreKey(SESSION);
    ProjectionStore.setProjectionV2Enabled(SESSION, undefined, true);
    ProjectionStore.ingest(key, {
      session_id: SESSION,
      thread_id: "thread-before-rollback",
      turn_id: "turn-before-rollback",
      seq: 1,
      client_message_id: "cmid-before-rollback",
      cursor: { stream: SESSION, seq: 1 },
      payload: { type: "user_message", data: { text: "drop me", files: [] } },
    });
    // This represents stale legacy state left over from an earlier
    // old-server connection. v2 rollback must not touch it.
    ThreadStore.addUserMessage(SESSION, {
      text: "legacy fallback remains untouched",
      clientMessageId: "cmid-legacy",
    });
    rollbackSession.mockResolvedValue(trimmedResult());
    hydrateSession.mockResolvedValue({
      projection_snapshot: {
        cursor: { stream: SESSION, seq: 2 },
        envelopes: [
          {
            session_id: SESSION,
            thread_id: "thread-kept",
            turn_id: "turn-kept",
            seq: 1,
            client_message_id: "cmid-keep",
            cursor: { stream: SESSION, seq: 1 },
            payload: {
              type: "user_message",
              data: { text: "canonical keep", files: [] },
            },
          },
          {
            session_id: SESSION,
            thread_id: "thread-kept",
            turn_id: "turn-kept",
            seq: 2,
            cursor: { stream: SESSION, seq: 2 },
            payload: {
              type: "assistant_persisted",
              data: {
                assistant_segment_id: "segment-kept",
                text: "canonical reply",
                meta: {
                  message_id: "message-kept",
                  persisted_at: "2026-07-18T00:00:00Z",
                },
              },
            },
          },
        ],
      },
    });
    mockBridge = { rollbackSession, hydrateSession };

    const outcome = await rollbackSessionTurns(SESSION, undefined, 1);

    expect(outcome).toEqual({ ok: true, droppedTurns: 1 });
    expect(hydrateSession).toHaveBeenCalledWith(["messages"]);
    expect(ProjectionStore.getProjection(key).threads[0]?.user?.text).toBe(
      "canonical keep",
    );
    expect(
      ProjectionStore.getProjection(key).threads[0]?.assistantSegments[0]?.text,
    ).toBe("canonical reply");
    expect(ThreadStore.getThreads(SESSION)[0]?.userMsg.text).toBe(
      "legacy fallback remains untouched",
    );
  });

  it("surgically trims the dropped suffix and keeps surviving threads", async () => {
    // Local store holds TWO turns; the server trims to one.
    ThreadStore.addUserMessage(SESSION, {
      text: "keep me",
      clientMessageId: "cmid-keep",
    });
    ThreadStore.appendAssistantToken("cmid-keep", "kept reply");
    ThreadStore.finalizeAssistant("cmid-keep", { committedSeq: 2 });
    ThreadStore.addUserMessage(SESSION, {
      text: "drop me",
      clientMessageId: "cmid-drop",
    });
    ThreadStore.appendAssistantToken("cmid-drop", "dropped reply");
    ThreadStore.finalizeAssistant("cmid-drop", { committedSeq: 4 });
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(2);

    rollbackSession.mockResolvedValue(trimmedResult());
    const outcome = await rollbackSessionTurns(SESSION, undefined, 1);
    expect(outcome).toEqual({ ok: true, droppedTurns: 1 });
    expect(rollbackSession).toHaveBeenCalledWith(1);

    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].userMsg.text).toBe("keep me");
    // The rolled-back turn is gone locally, not just deprioritised.
    expect(JSON.stringify(threads)).not.toContain("drop me");
    // Surgical trim, NOT clear+reseed: the surviving thread keeps its
    // finalized assistant response verbatim (hydrate rows carry no
    // rich state, so a reseed would visibly degrade it).
    expect(threads[0].responses[0]?.text).toBe("kept reply");
  });

  it("falls back to exact-scope clear+reseed when local rows disagree with dropped_turns", async () => {
    // Local store has ONE user turn but the server reports dropping 2 —
    // the local view was inconsistent; reconcile from the projection.
    ThreadStore.addUserMessage(SESSION, {
      text: "only local turn",
      clientMessageId: "cmid-only",
    });
    // Sibling topic cache must SURVIVE the reconciliation (exact-key
    // clear — the RPC did not touch the topic bucket).
    ThreadStore.addUserMessage(SESSION, {
      text: "topic turn",
      clientMessageId: "cmid-topic",
      topic: "slides",
    });
    rollbackSession.mockResolvedValue({
      ...trimmedResult(),
      dropped_turns: 2,
    });
    const outcome = await rollbackSessionTurns(SESSION, undefined, 2);
    expect(outcome).toEqual({ ok: true, droppedTurns: 2 });
    // Root scope reseeded from the projection…
    const rootThreads = ThreadStore.getThreads(SESSION);
    expect(JSON.stringify(rootThreads)).toContain("keep me");
    expect(JSON.stringify(rootThreads)).not.toContain("only local turn");
    // …while the topic bucket is untouched.
    const topicThreads = ThreadStore.getThreads(SESSION, "slides");
    expect(topicThreads).toHaveLength(1);
    expect(topicThreads[0].userMsg.text).toBe("topic turn");
  });

  it("refuses a concurrent rollback for the same scope (relative counts)", async () => {
    ThreadStore.addUserMessage(SESSION, {
      text: "turn",
      clientMessageId: "cmid-lock",
    });
    let resolveRpc!: (v: unknown) => void;
    rollbackSession.mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve;
      }),
    );
    const first = rollbackSessionTurns(SESSION, undefined, 1);
    // Second rollback while the first RPC is in flight → busy.
    const second = await rollbackSessionTurns(SESSION, undefined, 1);
    expect(second).toEqual({ ok: false, reason: "busy" });
    resolveRpc(trimmedResult());
    const firstOutcome = await first;
    expect(firstOutcome.ok).toBe(true);
    // Lock released → a later rollback may start again.
    rollbackSession.mockResolvedValue(trimmedResult());
    const third = await rollbackSessionTurns(SESSION, undefined, 1);
    expect(third.ok).toBe(true);
  });

  it("maps the server busy-guard to turn_in_progress and leaves the store intact", async () => {
    ThreadStore.addUserMessage(SESSION, {
      text: "still here",
      clientMessageId: "cmid-still",
    });
    rollbackSession.mockRejectedValue(
      new Error(
        'session/rollback: a turn is in progress; interrupt it before rolling back {"kind":"turn_in_progress"}',
      ),
    );
    const outcome = await rollbackSessionTurns(SESSION, undefined, 1);
    expect(outcome).toEqual({ ok: false, reason: "turn_in_progress" });
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(1);
  });

  it("reports rpc_failed on other errors without touching the store", async () => {
    ThreadStore.addUserMessage(SESSION, {
      text: "still here",
      clientMessageId: "cmid-still-2",
    });
    rollbackSession.mockRejectedValue(new Error("boom"));
    const outcome = await rollbackSessionTurns(SESSION, undefined, 1);
    expect(outcome).toEqual({ ok: false, reason: "rpc_failed" });
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(1);
  });

  it("reports no_bridge when the scope has no connected bridge", async () => {
    mockBridge = null;
    const outcome = await rollbackSessionTurns(SESSION, undefined, 1);
    expect(outcome).toEqual({ ok: false, reason: "no_bridge" });
  });

  // ── codex #262 round 2 folds ─────────────────────────────────────────────

  it("reconciles from the projection when the server CLAMPS the count", async () => {
    // Local has 2 turns; the user asked for 2 but the server only had
    // 1 persisted turn and clamped. Local trim of 1 would "succeed"
    // (droppedLocally === dropped_turns) yet local and server now
    // disagree about the surviving prefix — the request was computed
    // against indices the server never shared. Must clear + reseed.
    ThreadStore.addUserMessage(SESSION, {
      text: "local-only stale turn",
      clientMessageId: "cmid-stale",
    });
    ThreadStore.addUserMessage(SESSION, {
      text: "drop me",
      clientMessageId: "cmid-drop-clamp",
    });
    rollbackSession.mockResolvedValue({
      ...trimmedResult(),
      dropped_turns: 1,
    });
    const outcome = await rollbackSessionTurns(SESSION, undefined, 2);
    expect(outcome).toEqual({ ok: true, droppedTurns: 1 });
    const threads = ThreadStore.getThreads(SESSION);
    // Reseeded from the server projection — the stale local turn the
    // server never had is gone.
    expect(JSON.stringify(threads)).toContain("keep me");
    expect(JSON.stringify(threads)).not.toContain("local-only stale turn");
  });

  it("replaces the hydrate-snapshot cache on the SURGICAL path too", async () => {
    // Pre-rollback the scope's cached hydrate snapshot contains the
    // dropped turn; a later replay/dedup pass reading the stale cache
    // would resurrect it. After a successful surgical rollback the
    // cache must hold exactly the trimmed projection.
    ThreadStore.setHydrateSnapshot(SESSION, undefined, {
      messages: [
        {
          seq: 1,
          role: "user",
          content: "keep me",
          client_message_id: "cmid-keep",
          message_id: "m1",
          persisted_at: "2026-07-10T00:00:00Z",
        },
        {
          seq: 2,
          role: "assistant",
          content: "kept reply",
          message_id: "m2",
          persisted_at: "2026-07-10T00:00:01Z",
        },
        {
          seq: 3,
          role: "user",
          content: "drop me",
          client_message_id: "cmid-drop",
          message_id: "m3",
          persisted_at: "2026-07-10T00:00:02Z",
        },
      ],
    });
    ThreadStore.addUserMessage(SESSION, {
      text: "drop me",
      clientMessageId: "cmid-drop",
    });
    expect(ThreadStore.getThreads(SESSION).length).toBeGreaterThanOrEqual(2);
    rollbackSession.mockResolvedValue(trimmedResult());
    const outcome = await rollbackSessionTurns(SESSION, undefined, 1);
    expect(outcome.ok).toBe(true);
    const cached = ThreadStore.__getHydrateSnapshotForTest(SESSION);
    expect(cached).toBeDefined();
    expect(JSON.stringify(cached)).not.toContain("drop me");
    expect(cached?.messages).toHaveLength(2);
  });

  it("rebuilds the seq-dedup ledger so renumbered seqs are accepted after the trim", async () => {
    // The server renumbers persisted seqs from the trimmed length, so
    // the first post-rollback commits REUSE seqs the dropped suffix
    // burned. A stale ledger makes appendPersistedMessage discard them.
    ThreadStore.addUserMessage(SESSION, {
      text: "keep me",
      clientMessageId: "cmid-keep",
    });
    ThreadStore.appendAssistantToken("cmid-keep", "kept reply");
    ThreadStore.finalizeAssistant("cmid-keep", { committedSeq: 2 });
    ThreadStore.addUserMessage(SESSION, {
      text: "drop me",
      clientMessageId: "cmid-drop-seq",
    });
    ThreadStore.appendAssistantToken("cmid-drop-seq", "dropped reply");
    // Burns seq 4 into the ledger for the suffix we're about to drop.
    ThreadStore.finalizeAssistant("cmid-drop-seq", { committedSeq: 4 });
    rollbackSession.mockResolvedValue(trimmedResult());
    const outcome = await rollbackSessionTurns(SESSION, undefined, 1);
    expect(outcome.ok).toBe(true);
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(1);
    // A fresh persisted row REUSING the dropped suffix's seq 4 must
    // land (post-rollback renumbering)…
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 4,
      role: "assistant",
      content: "fresh post-rollback reply",
      thread_id: "cmid-keep",
      message_id: "m-fresh",
      timestamp: "2026-07-10T00:00:03Z",
    } as never);
    const [thread] = ThreadStore.getThreads(SESSION);
    expect(
      thread.responses.some((r) => r.text === "fresh post-rollback reply"),
    ).toBe(true);
    // …while a replay of a SURVIVING seq (2) still dedups.
    const before = thread.responses.length;
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 2,
      role: "assistant",
      content: "kept reply (replayed)",
      thread_id: "cmid-keep",
      message_id: "m-replay",
      timestamp: "2026-07-10T00:00:04Z",
    } as never);
    expect(ThreadStore.getThreads(SESSION)[0].responses).toHaveLength(before);
  });

  // ── codex #262 round 3 folds ─────────────────────────────────────────────

  it("replayHistory carries an unresolved orphan's provenance forward", () => {
    // A real turn + a late stream for an unknown thread (orphan with
    // in-flight pending). A forced replay whose rows STILL lack the
    // orphan's user row must carry the bucket forward AS an orphan —
    // round 3 P1: dropping the flag let it bypass the rewind gate and
    // count as a real turn, inflating num_turns for earlier bubbles.
    ThreadStore.addUserMessage(SESSION, {
      text: "real prompt",
      clientMessageId: "cmid-real",
    });
    ThreadStore.appendAssistantToken("orphan-carry", "late stream");
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(true);
    ThreadStore.replayHistory(SESSION, [
      {
        role: "user",
        content: "real prompt",
        client_message_id: "cmid-real",
        thread_id: "cmid-real",
        timestamp: "2026-07-10T00:00:00Z",
      },
    ] as never);
    const carried = ThreadStore.getThreads(SESSION).find(
      (t) => t.id === "orphan-carry",
    );
    expect(carried).toBeTruthy();
    expect(ThreadStore.isPlaceholderThread(carried!)).toBe(true);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(true);
  });

  it("replayHistory adopts a synthesized bucket when its user row follows", () => {
    // Assistant row precedes its user row in the same replay batch —
    // the synthesized bucket must become a KNOWN turn when the user
    // row lands (round 3 P2: it stayed a placeholder and suppressed
    // Rewind for every turn indefinitely).
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 2,
        role: "assistant",
        content: "answer",
        thread_id: "t1",
        message_id: "m2",
        timestamp: "2026-07-10T00:00:01Z",
      },
      {
        seq: 1,
        role: "user",
        content: "prompt",
        client_message_id: "t1",
        thread_id: "t1",
        timestamp: "2026-07-10T00:00:00Z",
      },
    ] as never);
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].userMsg.text).toBe("prompt");
    expect(ThreadStore.isPlaceholderThread(threads[0])).toBe(false);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(false);
  });

  it("applyVoiceTranscript fills an orphan but leaves the rewind gate closed", () => {
    // Rounds 3→5: a transcript proves the turn exists but carries no
    // ORDER (no persisted timestamp/seq), so it must not open the
    // rewind gate — the persisted user echo that follows carries both
    // and adopts via the order-restoring path. Real voice turns are
    // minted by addUserMessage and were never placeholders.
    ThreadStore.addUserMessage(SESSION, {
      text: "anchor",
      clientMessageId: "cmid-anchor",
    });
    ThreadStore.appendAssistantToken("orphan-voice", "streamed");
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(true);
    const applied = ThreadStore.applyVoiceTranscript(
      SESSION,
      undefined,
      "orphan-voice",
      "what I said",
    );
    expect(applied).toBe(true);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(true);
    // The persisted echoes (timestamp + seq for EVERY root) adopt it.
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 5,
      role: "user",
      content: "anchor",
      client_message_id: "cmid-anchor",
      thread_id: "cmid-anchor",
      timestamp: "2026-07-10T00:00:04Z",
    } as never);
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 7,
      role: "user",
      content: "what I said",
      client_message_id: "orphan-voice",
      thread_id: "orphan-voice",
      timestamp: "2026-07-10T00:00:06Z",
    } as never);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(false);
  });

  it("unions the projection's seqs so re-emissions for seq-stripped survivors dedup", async () => {
    // messages_page replay strips seq → surviving rows carry NO
    // historySeq, so the post-trim ledger rebuild alone would forget
    // them and a live re-emission would append a duplicate (round 3
    // P2). The rollback projection carries the authoritative seqs.
    ThreadStore.replayHistory(SESSION, [
      {
        role: "user",
        content: "keep me",
        client_message_id: "cmid-keep",
        thread_id: "cmid-keep",
        timestamp: "2026-07-10T00:00:00Z",
      },
      {
        role: "assistant",
        content: "kept reply",
        thread_id: "cmid-keep",
        message_id: "m2",
        timestamp: "2026-07-10T00:00:01Z",
      },
      {
        role: "user",
        content: "drop me",
        client_message_id: "cmid-drop",
        thread_id: "cmid-drop",
        timestamp: "2026-07-10T00:00:02Z",
      },
    ] as never);
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(2);
    rollbackSession.mockResolvedValue(trimmedResult());
    const outcome = await rollbackSessionTurns(SESSION, undefined, 1);
    expect(outcome.ok).toBe(true);
    const [thread] = ThreadStore.getThreads(SESSION);
    const before = thread.responses.length;
    // Live re-emission of the SURVIVING assistant row (projection seq
    // 2) under a fresh message_id: only the unioned ledger dedups it.
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 2,
      role: "assistant",
      content: "kept reply",
      thread_id: "cmid-keep",
      message_id: "m2-reemit",
      timestamp: "2026-07-10T00:00:03Z",
    } as never);
    expect(ThreadStore.getThreads(SESSION)[0].responses).toHaveLength(before);
  });

  it("hydrate rows (media or not) normalize order and adopt the orphan by seq", () => {
    // codex #262 rounds 4-6: a late background assistant mints the
    // orphan at ASSISTANT-arrival time, placing an OLDER media turn
    // AFTER a newer prompt. The gate opens only once EVERY user root
    // carries server order; the sibling's order arrives via its
    // NO-media hydrate row (round 6 P2), the orphan's via its media
    // row. Sorting by per-session seq restores the server order.
    ThreadStore.addUserMessage(SESSION, {
      text: "newer prompt",
      clientMessageId: "cmid-new",
    });
    ThreadStore.appendAssistantToken("cmid-old", "late narration");
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(true);
    expect(ThreadStore.getThreads(SESSION).map((t) => t.id)).toEqual([
      "cmid-new",
      "cmid-old",
    ]);
    ThreadStore.setHydrateSnapshot(SESSION, undefined, {
      messages: [
        {
          seq: 1,
          role: "user",
          content: "older prompt",
          client_message_id: "cmid-old",
          media: ["uploads/x.wav"],
          persisted_at: "2026-07-09T00:00:00Z",
        },
        {
          seq: 3,
          role: "user",
          content: "newer prompt",
          client_message_id: "cmid-new",
          persisted_at: "2026-07-09T00:00:01Z",
        },
      ],
    });
    // Adopted AND reordered: the older turn now precedes the newer one.
    expect(ThreadStore.getThreads(SESSION).map((t) => t.id)).toEqual([
      "cmid-old",
      "cmid-new",
    ]);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(false);
  });

  it("keeps the gate closed while ANY user root lacks server order", () => {
    // The orphan's own row carries seq, but the optimistic sibling's
    // echo hasn't landed — its root is still in the client clock
    // domain, so placement would mix domains (round 6 P1).
    ThreadStore.addUserMessage(SESSION, {
      text: "newer prompt",
      clientMessageId: "cmid-new2",
    });
    ThreadStore.appendAssistantToken("cmid-old2", "late narration");
    ThreadStore.setHydrateSnapshot(SESSION, undefined, {
      messages: [
        {
          seq: 1,
          role: "user",
          content: "older prompt",
          client_message_id: "cmid-old2",
          media: ["uploads/y.wav"],
          persisted_at: "2026-07-09T00:00:00Z",
        },
      ],
    });
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(true);
  });

  it("persisted echoes normalize every root; the second echo adopts and reorders (codex rounds 5-6)", () => {
    // Newer real prompt first; late stream mints the orphan AFTER it.
    ThreadStore.addUserMessage(SESSION, {
      text: "newer prompt",
      clientMessageId: "cmid-new5",
    });
    ThreadStore.appendAssistantToken("cmid-old5", "late stream");
    expect(ThreadStore.getThreads(SESSION).map((t) => t.id)).toEqual([
      "cmid-new5",
      "cmid-old5",
    ]);
    // The orphan's echo alone must NOT open the gate: the optimistic
    // sibling is still client-clocked (round 6 P1 — mixed domains).
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 1,
      role: "user",
      content: "older prompt",
      client_message_id: "cmid-old5",
      thread_id: "cmid-old5",
      timestamp: "2026-07-09T00:00:00Z",
    } as never);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(true);
    // The sibling's own echo lands moments later (normal send flow) —
    // every root is now server-ordered, so adoption sorts by seq.
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 3,
      role: "user",
      content: "newer prompt",
      client_message_id: "cmid-new5",
      thread_id: "cmid-new5",
      timestamp: "2026-07-09T00:00:01Z",
    } as never);
    expect(ThreadStore.getThreads(SESSION).map((t) => t.id)).toEqual([
      "cmid-old5",
      "cmid-new5",
    ]);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(false);
  });

  it("keeps the gate closed while a seq-stripped sibling remains (codex rounds 5-6)", () => {
    // Sibling built by replay WITHOUT seq (messages_page strips it) —
    // even an identical timestamp cannot order the pair (sub-ms server
    // times collapse under Date.parse), so seq is the only axis and
    // the sibling doesn't have one yet.
    ThreadStore.replayHistory(SESSION, [
      {
        role: "user",
        content: "sibling",
        client_message_id: "cmid-sib",
        thread_id: "cmid-sib",
        timestamp: "2026-07-10T00:00:05Z",
      },
    ] as never);
    ThreadStore.appendAssistantToken("cmid-tie", "late stream");
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 4,
      role: "user",
      content: "tied prompt",
      client_message_id: "cmid-tie",
      thread_id: "cmid-tie",
      timestamp: "2026-07-10T00:00:05Z",
    } as never);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(true);
  });

  it("nudges ONE forced REST replay when an echo cannot resolve the scope (codex round 7)", async () => {
    // Topic-scope shape: the sibling came from messages_page (no seq)
    // and no hydrate will ever supply one. The orphan's echo cannot
    // open the gate — but the echoed turn IS persisted now, so the
    // store falls back to one forced REST replay, which re-roots both
    // user rows in server order and resolves the placeholder.
    ThreadStore.replayHistory(
      SESSION,
      [
        {
          role: "user",
          content: "sibling",
          client_message_id: "cmid-sib3",
          thread_id: "cmid-sib3",
          timestamp: "2026-07-10T00:00:01Z",
        },
      ] as never,
      "slides",
    );
    ThreadStore.appendToolProgress("cmid-late3", "tc-1", "late progress");
    // The orphan landed in the slides scope alongside the sibling.
    expect(ThreadStore.hasPlaceholderThreads(SESSION, "slides")).toBe(true);
    getMessagesPage.mockResolvedValue({
      messages: [
        {
          role: "user",
          content: "sibling",
          client_message_id: "cmid-sib3",
          thread_id: "cmid-sib3",
          timestamp: "2026-07-10T00:00:01Z",
        },
        {
          role: "user",
          content: "late prompt",
          client_message_id: "cmid-late3",
          thread_id: "cmid-late3",
          timestamp: "2026-07-10T00:00:02Z",
        },
        {
          role: "assistant",
          content: "late reply",
          thread_id: "cmid-late3",
          timestamp: "2026-07-10T00:00:03Z",
        },
      ],
      has_more: false,
    });
    ThreadStore.appendPersistedMessage(SESSION, "slides", {
      seq: 4,
      role: "user",
      content: "late prompt",
      client_message_id: "cmid-late3",
      thread_id: "cmid-late3",
      timestamp: "2026-07-10T00:00:02Z",
    } as never);
    // Echo alone: gate still closed (sibling has no seq)…
    expect(ThreadStore.hasPlaceholderThreads(SESSION, "slides")).toBe(true);
    // …but the nudge fired one forced replay; let it land (macrotask
    // flush drains the nudge's chained awaits deterministically).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(getMessagesPage).toHaveBeenCalledTimes(1);
    expect(ThreadStore.hasPlaceholderThreads(SESSION, "slides")).toBe(false);
    const threads = ThreadStore.getThreads(SESSION, "slides");
    expect(threads.map((t) => t.userMsg.text)).toEqual([
      "sibling",
      "late prompt",
    ]);
  });

  it("drains a stale in-flight load, then issues a FRESH forced replay (codex round 8 P1)", async () => {
    // A mount/reconnect load is in flight and its response PREDATES
    // the echoed row. The nudge must not coalesce onto it — it waits
    // it out and fires a fresh request that includes the row.
    ThreadStore.replayHistory(
      SESSION,
      [
        {
          role: "user",
          content: "slides anchor",
          client_message_id: "cmid-anchor8",
          thread_id: "cmid-anchor8",
          timestamp: "2026-07-10T00:00:01Z",
        },
      ] as never,
      "slides",
    );
    let resolveStale!: (v: unknown) => void;
    getMessagesPage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStale = resolve;
      }),
    );
    const staleLoad = ThreadStore.loadHistory(SESSION, "slides", {
      force: true,
    });
    ThreadStore.appendToolProgress("cmid-late8", "tc-8", "late progress");
    expect(ThreadStore.hasPlaceholderThreads(SESSION, "slides")).toBe(true);
    // Fresh (post-echo) response for the SECOND request only.
    getMessagesPage.mockResolvedValue({
      messages: [
        {
          role: "user",
          content: "slides anchor",
          client_message_id: "cmid-anchor8",
          thread_id: "cmid-anchor8",
          timestamp: "2026-07-10T00:00:01Z",
        },
        {
          role: "user",
          content: "late prompt",
          client_message_id: "cmid-late8",
          thread_id: "cmid-late8",
          timestamp: "2026-07-10T00:00:02Z",
        },
      ],
      has_more: false,
    });
    ThreadStore.appendPersistedMessage(SESSION, "slides", {
      seq: 4,
      role: "user",
      content: "late prompt",
      client_message_id: "cmid-late8",
      thread_id: "cmid-late8",
      timestamp: "2026-07-10T00:00:02Z",
    } as never);
    // The stale response lands WITHOUT the late row.
    resolveStale({
      messages: [
        {
          role: "user",
          content: "slides anchor",
          client_message_id: "cmid-anchor8",
          thread_id: "cmid-anchor8",
          timestamp: "2026-07-10T00:00:01Z",
        },
      ],
      has_more: false,
    });
    await staleLoad;
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // stale + fresh = 2 requests; the fresh one resolved the scope.
    expect(getMessagesPage).toHaveBeenCalledTimes(2);
    expect(ThreadStore.hasPlaceholderThreads(SESSION, "slides")).toBe(false);
  });

  it("re-arms the nudge for a later episode in the same scope (codex round 8 P2)", async () => {
    // Root scope seeded via replay (roots carry no seq — the shape
    // that makes echoes unresolvable and forces the nudge).
    ThreadStore.replayHistory(SESSION, [
      {
        role: "user",
        content: "root anchor",
        client_message_id: "cmid-anchor-r",
        thread_id: "cmid-anchor-r",
        timestamp: "2026-07-10T00:00:00Z",
      },
    ] as never);
    // Episode 1: orphan + echo → nudge resolves it.
    ThreadStore.appendToolProgress("cmid-ep1", "tc-e1", "late progress");
    getMessagesPage.mockResolvedValue({
      messages: [
        {
          role: "user",
          content: "root anchor",
          client_message_id: "cmid-anchor-r",
          thread_id: "cmid-anchor-r",
          timestamp: "2026-07-10T00:00:00Z",
        },
        {
          role: "user",
          content: "ep1 prompt",
          client_message_id: "cmid-ep1",
          thread_id: "cmid-ep1",
          timestamp: "2026-07-10T00:00:01Z",
        },
      ],
      has_more: false,
    });
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 2,
      role: "user",
      content: "ep1 prompt",
      client_message_id: "cmid-ep1",
      thread_id: "cmid-ep1",
      timestamp: "2026-07-10T00:00:01Z",
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(false);
    const callsAfterEp1 = getMessagesPage.mock.calls.length;
    expect(callsAfterEp1).toBeGreaterThan(0);
    // Episode 2 in the SAME scope: a new orphan must nudge again.
    ThreadStore.appendToolProgress("cmid-ep2", "tc-e2", "late progress");
    getMessagesPage.mockResolvedValue({
      messages: [
        {
          role: "user",
          content: "root anchor",
          client_message_id: "cmid-anchor-r",
          thread_id: "cmid-anchor-r",
          timestamp: "2026-07-10T00:00:00Z",
        },
        {
          role: "user",
          content: "ep1 prompt",
          client_message_id: "cmid-ep1",
          thread_id: "cmid-ep1",
          timestamp: "2026-07-10T00:00:01Z",
        },
        {
          role: "user",
          content: "ep2 prompt",
          client_message_id: "cmid-ep2",
          thread_id: "cmid-ep2",
          timestamp: "2026-07-10T00:00:03Z",
        },
      ],
      has_more: false,
    });
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 4,
      role: "user",
      content: "ep2 prompt",
      client_message_id: "cmid-ep2",
      thread_id: "cmid-ep2",
      timestamp: "2026-07-10T00:00:03Z",
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(getMessagesPage.mock.calls.length).toBeGreaterThan(callsAfterEp1);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(false);
  });

  it("nudges the scope that OWNS the orphan, not the event's scope (codex round 8 P2)", async () => {
    // Orphan lives in the slides scope; the echo arrives addressed to
    // the ROOT scope but findThreadById locates the bucket in slides.
    // The forced replay must target slides.
    ThreadStore.replayHistory(
      SESSION,
      [
        {
          role: "user",
          content: "slides anchor",
          client_message_id: "cmid-anchor9",
          thread_id: "cmid-anchor9",
          timestamp: "2026-07-10T00:00:01Z",
        },
      ] as never,
      "slides",
    );
    ThreadStore.appendToolProgress("cmid-cross9", "tc-9", "late progress");
    expect(ThreadStore.hasPlaceholderThreads(SESSION, "slides")).toBe(true);
    getMessagesPage.mockResolvedValue({
      messages: [
        {
          role: "user",
          content: "slides anchor",
          client_message_id: "cmid-anchor9",
          thread_id: "cmid-anchor9",
          timestamp: "2026-07-10T00:00:01Z",
        },
        {
          role: "user",
          content: "cross prompt",
          client_message_id: "cmid-cross9",
          thread_id: "cmid-cross9",
          timestamp: "2026-07-10T00:00:02Z",
        },
      ],
      has_more: false,
    });
    // Echo addressed to the ROOT scope (no topic).
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 5,
      role: "user",
      content: "cross prompt",
      client_message_id: "cmid-cross9",
      thread_id: "cmid-cross9",
      timestamp: "2026-07-10T00:00:02Z",
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // The refetch went to the slides topic (5th arg of getMessagesPage).
    const topics = getMessagesPage.mock.calls.map((c) => c[4]);
    expect(topics).toContain("slides");
    expect(ThreadStore.hasPlaceholderThreads(SESSION, "slides")).toBe(false);
  });

  it("queues an echo that lands during an in-flight nudge and fetches again (codex round 9 P1)", async () => {
    // Scope seeded via replay (roots carry no seq → echoes can't open
    // the gate → nudges fire).
    ThreadStore.replayHistory(SESSION, [
      {
        role: "user",
        content: "anchor",
        client_message_id: "cmid-anchor-q",
        thread_id: "cmid-anchor-q",
        timestamp: "2026-07-10T00:00:00Z",
      },
    ] as never);
    ThreadStore.appendToolProgress("cmid-qa", "tc-qa", "late progress");
    ThreadStore.appendToolProgress("cmid-qb", "tc-qb", "late progress");
    const anchorRow = {
      role: "user",
      content: "anchor",
      client_message_id: "cmid-anchor-q",
      thread_id: "cmid-anchor-q",
      timestamp: "2026-07-10T00:00:00Z",
    };
    const rowA = {
      role: "user",
      content: "prompt A",
      client_message_id: "cmid-qa",
      thread_id: "cmid-qa",
      timestamp: "2026-07-10T00:00:01Z",
    };
    const rowB = {
      role: "user",
      content: "prompt B",
      client_message_id: "cmid-qb",
      thread_id: "cmid-qb",
      timestamp: "2026-07-10T00:00:02Z",
    };
    // Nudge #1's fetch: response predates echo B (no rowB) and is held
    // open until after echo B lands.
    let resolveFirst!: (v: unknown) => void;
    getMessagesPage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 2,
      role: "user",
      content: "prompt A",
      client_message_id: "cmid-qa",
      thread_id: "cmid-qa",
      timestamp: "2026-07-10T00:00:01Z",
    } as never);
    await new Promise((r) => setTimeout(r, 0));
    // Echo B arrives while nudge #1 is fetching → queued, not dropped.
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 4,
      role: "user",
      content: "prompt B",
      client_message_id: "cmid-qb",
      thread_id: "cmid-qb",
      timestamp: "2026-07-10T00:00:02Z",
    } as never);
    // Follow-up fetch sees the full post-B history.
    getMessagesPage.mockResolvedValue({
      messages: [anchorRow, rowA, rowB],
      has_more: false,
    });
    resolveFirst({ messages: [anchorRow, rowA], has_more: false });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Two forced loads: the in-flight one + the queued follow-up.
    expect(getMessagesPage.mock.calls.length).toBe(2);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(false);
    expect(
      ThreadStore.getThreads(SESSION).map((t) => t.userMsg.text),
    ).toEqual(["anchor", "prompt A", "prompt B"]);
  });

  it("orders equal-timestamp roots by seq once every root carries one (codex rounds 5-6)", () => {
    ThreadStore.replayHistory(SESSION, [
      {
        seq: 3,
        role: "user",
        content: "sibling",
        client_message_id: "cmid-sib2",
        thread_id: "cmid-sib2",
        timestamp: "2026-07-10T00:00:05Z",
      },
    ] as never);
    ThreadStore.appendAssistantToken("cmid-tie2", "late stream");
    // Echo ties on timestamp but carries seq 1 < 3 → placed BEFORE the
    // sibling, gate opens.
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 1,
      role: "user",
      content: "tied prompt",
      client_message_id: "cmid-tie2",
      thread_id: "cmid-tie2",
      timestamp: "2026-07-10T00:00:05Z",
    } as never);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(false);
    expect(ThreadStore.getThreads(SESSION).map((t) => t.id)).toEqual([
      "cmid-tie2",
      "cmid-sib2",
    ]);
  });

  it("treats provenance placeholders — not empty-shaped rows — as non-turns", () => {
    // A bucket synthesized for a late persisted assistant row (no user
    // message yet) IS a placeholder…
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 9,
      role: "assistant",
      content: "late reply",
      thread_id: "thread-late",
      message_id: "m-late",
      timestamp: "2026-07-10T00:00:05Z",
    } as never);
    const [synth] = ThreadStore.getThreads(SESSION);
    expect(ThreadStore.isPlaceholderThread(synth)).toBe(true);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(true);
    // …until its persisted user record arrives (adoption clears it).
    ThreadStore.appendPersistedMessage(SESSION, undefined, {
      seq: 8,
      role: "user",
      content: "the real prompt",
      client_message_id: "thread-late",
      thread_id: "thread-late",
      timestamp: "2026-07-10T00:00:04Z",
    } as never);
    const [adopted] = ThreadStore.getThreads(SESSION);
    expect(adopted.userMsg.text).toBe("the real prompt");
    expect(ThreadStore.isPlaceholderThread(adopted)).toBe(false);
    expect(ThreadStore.hasPlaceholderThreads(SESSION)).toBe(false);
  });
});
