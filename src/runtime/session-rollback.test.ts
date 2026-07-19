import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ProjectionStore from "@/store/projection-store";

const rollbackSession = vi.fn();
const hydrateSession = vi.fn();
let mockBridge: {
  rollbackSession: typeof rollbackSession;
  hydrateSession: typeof hydrateSession;
} | null = null;

vi.mock("./ui-protocol-runtime", () => ({
  getActiveBridge: () => mockBridge,
}));

import {
  isRollbackBusy,
  rollbackSessionTurns,
} from "./session-rollback";

const sessionId = "session-rollback";

function envelope(seq: number, type: "user_message" | "assistant_persisted") {
  return type === "user_message"
    ? {
        session_id: sessionId,
        thread_id: "thread-kept",
        turn_id: "turn-kept",
        seq,
        client_message_id: "cmid-kept",
        cursor: { stream: sessionId, seq },
        payload: { type, data: { text: "keep this", files: [] } },
      }
    : {
        session_id: sessionId,
        thread_id: "thread-kept",
        turn_id: "turn-kept",
        seq,
        cursor: { stream: sessionId, seq },
        payload: {
          type,
          data: {
            assistant_segment_id: "segment-kept",
            text: "canonical reply",
            meta: {
              message_id: "message-kept",
              persisted_at: "2026-07-18T00:00:00Z",
            },
          },
        },
      };
}

beforeEach(() => {
  rollbackSession.mockReset();
  hydrateSession.mockReset();
  mockBridge = { rollbackSession, hydrateSession };
});

afterEach(() => {
  ProjectionStore.__resetProjectionForTests();
});

describe("rollbackSessionTurns", () => {
  it("replaces the canonical projection with the post-rollback snapshot", async () => {
    const key = ProjectionStore.projectionStoreKey(sessionId);
    ProjectionStore.ingest(key, envelope(1, "user_message"));
    rollbackSession.mockResolvedValue({ dropped_turns: 1 });
    hydrateSession.mockResolvedValue({
      projection_snapshot: {
        cursor: { stream: sessionId, seq: 2 },
        envelopes: [envelope(1, "user_message"), envelope(2, "assistant_persisted")],
      },
    });

    await expect(rollbackSessionTurns(sessionId, undefined, 1)).resolves.toEqual({
      ok: true,
      droppedTurns: 1,
    });
    expect(hydrateSession).toHaveBeenCalledWith(["messages"]);
    expect(ProjectionStore.getProjection(key).threads[0]?.assistantSegments[0]?.text).toBe(
      "canonical reply",
    );
  });


  it("serializes relative rollbacks for the same canonical scope", async () => {
    let resolveRollback!: (value: { dropped_turns: number }) => void;
    rollbackSession.mockReturnValue(
      new Promise((resolve) => {
        resolveRollback = resolve;
      }),
    );
    hydrateSession.mockResolvedValue({ projection_envelopes: [] });

    const first = rollbackSessionTurns(sessionId, undefined, 1);
    expect(isRollbackBusy(sessionId)).toBe(true);
    await expect(rollbackSessionTurns(sessionId, undefined, 1)).resolves.toEqual({
      ok: false,
      reason: "busy",
    });
    resolveRollback({ dropped_turns: 1 });
    await expect(first).resolves.toEqual({ ok: true, droppedTurns: 1 });
    expect(isRollbackBusy(sessionId)).toBe(false);
  });
});
