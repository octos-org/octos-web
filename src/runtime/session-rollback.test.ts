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
});
