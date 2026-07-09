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
import type { SessionRollbackResult } from "./ui-protocol-types";

const rollbackSession = vi.fn();
vi.mock("./ui-protocol-runtime", () => ({
  getActiveBridge: () => mockBridge,
}));
// Reassigned per-test; `null` simulates a disconnected scope.
let mockBridge: { rollbackSession: typeof rollbackSession } | null = {
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
});

afterEach(() => {
  ThreadStore.__resetForTests();
});

describe("rollbackSessionTurns", () => {
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
