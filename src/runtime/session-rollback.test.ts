/**
 * session-rollback applier tests.
 *
 * The server's `session/rollback` returns the TRIMMED thread in the
 * hydrate shape. The applier must clear the local scope BEFORE seeding —
 * `setHydrateSnapshot` only adds/coalesces rows, so without the clear
 * the rolled-back bubbles would survive locally until a full reload.
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
  it("clears the scope and rebuilds it from the trimmed projection", async () => {
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
