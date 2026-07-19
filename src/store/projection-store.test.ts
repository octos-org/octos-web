import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectionEnvelopeV2,
  ProjectionEnvelopeV2Payload,
} from "@/runtime/projection-envelope-v2";
import * as ProjectionStore from "./projection-store";

function frame(
  seq: number,
  payload: ProjectionEnvelopeV2Payload,
  options: {
    threadId?: string;
    turnId?: string;
    cursor?: number;
    clientMessageId?: string;
  } = {},
): ProjectionEnvelopeV2 {
  return {
    session_id: "session-store",
    thread_id: options.threadId ?? "thread-store",
    turn_id: options.turnId ?? "turn-store",
    seq,
    cursor: { stream: "ledger-store", seq: options.cursor ?? seq },
    ...(options.clientMessageId
      ? { client_message_id: options.clientMessageId }
      : {}),
    payload,
  };
}

const user = (text: string): ProjectionEnvelopeV2Payload => ({
  type: "user_message",
  data: { text, files: [] },
});

const delta = (text: string): ProjectionEnvelopeV2Payload => ({
  type: "assistant_delta",
  data: { assistant_segment_id: "segment-store", text },
});

afterEach(() => {
  ProjectionStore.__resetProjectionForTests();
});

describe("ProjectionStore canonical admission", () => {
  it("starts at seq 1, buffers a gap, and requests rehydrate until it closes", () => {
    const key = ProjectionStore.projectionStoreKey("session-store");
    const request = vi.fn();
    const dispose = ProjectionStore.onRehydrateRequested(request);
    ProjectionStore.replaceSnapshot(key, [], { stream: "ledger-store", seq: 10 });

    expect(ProjectionStore.ingest(key, frame(2, delta("second"), { cursor: 12 }))).toEqual({
      accepted: false,
      duplicate: false,
      gapDetected: true,
    });
    expect(request).toHaveBeenCalledWith(key, { stream: "ledger-store", seq: 10 });
    expect(ProjectionStore.getEnvelopes(key)).toEqual([]);

    expect(
      ProjectionStore.ingest(
        key,
        frame(1, user("first"), {
          cursor: 11,
          clientMessageId: "cmid-exact",
        }),
      ),
    ).toMatchObject({ accepted: true, gapDetected: false });
    expect(ProjectionStore.getEnvelopes(key).map((entry) => entry.seq)).toEqual([
      1,
      2,
    ]);
    expect(ProjectionStore.hasCmid(key, "cmid-exact")).toBe(true);
    expect(ProjectionStore.hasCmid(key, "not-an-assistant-or-guess")).toBe(false);
    expect(ProjectionStore.getWatermark(key)).toEqual({
      stream: "ledger-store",
      seq: 12,
    });
    dispose();
  });

  it("does not advance a reconnect watermark across another thread's ledger hole", () => {
    const key = ProjectionStore.projectionStoreKey("session-store");
    const request = vi.fn();
    const dispose = ProjectionStore.onRehydrateRequested(request);
    ProjectionStore.replaceSnapshot(key, [], { stream: "ledger-store", seq: 10 });

    // `thread-a` is locally contiguous at seq 1, but its global ledger
    // cursor proves that a different stream entry (cursor 11) is absent.
    // Advancing to 12 here would make a reconnect permanently skip it.
    expect(
      ProjectionStore.ingest(
        key,
        frame(1, user("thread a"), {
          threadId: "thread-a",
          cursor: 12,
          clientMessageId: "cmid-a",
        }),
      ),
    ).toMatchObject({ accepted: true, gapDetected: false });
    expect(ProjectionStore.getWatermark(key)).toEqual({
      stream: "ledger-store",
      seq: 10,
    });
    expect(ProjectionStore.hasRehydrateGap(key)).toBe(true);
    expect(request).toHaveBeenCalledWith(key, { stream: "ledger-store", seq: 10 });

    ProjectionStore.ingest(
      key,
      frame(1, user("thread b"), {
        threadId: "thread-b",
        cursor: 11,
        clientMessageId: "cmid-b",
      }),
    );
    expect(ProjectionStore.getWatermark(key)).toEqual({
      stream: "ledger-store",
      seq: 12,
    });
    expect(ProjectionStore.hasRehydrateGap(key)).toBe(false);
    dispose();
  });

  it("maps canonical user cmids by explicit turn id rather than thread order", () => {
    const key = ProjectionStore.projectionStoreKey("session-store");
    ProjectionStore.ingest(
      key,
      frame(1, user("first"), {
        turnId: "turn-first",
        clientMessageId: "cmid-first",
      }),
    );
    ProjectionStore.ingest(
      key,
      frame(2, user("second"), {
        turnId: "turn-second",
        clientMessageId: "cmid-second",
      }),
    );

    expect(ProjectionStore.clientMessageIdForTurn(key, "turn-first")).toBe(
      "cmid-first",
    );
    expect(ProjectionStore.clientMessageIdForTurn(key, "turn-second")).toBe(
      "cmid-second",
    );
  });

  it("buffers live frames during snapshot replacement and replays only after the ledger watermark", () => {
    const key = ProjectionStore.projectionStoreKey("session-store");
    ProjectionStore.beginSnapshot(key, { stream: "ledger-store", seq: 10 });

    // Both arrive while the durable snapshot is in flight.
    ProjectionStore.ingest(key, frame(1, user("old duplicate"), {
      cursor: 10,
      clientMessageId: "cmid-old",
    }));
    ProjectionStore.ingest(key, frame(2, delta("new live"), { cursor: 11 }));

    ProjectionStore.replaceSnapshot(
      key,
      [
        frame(1, user("snapshot"), {
          cursor: 10,
          clientMessageId: "cmid-snapshot",
        }),
      ],
      { stream: "ledger-store", seq: 10 },
    );

    expect(ProjectionStore.getEnvelopes(key).map((entry) => entry.seq)).toEqual([
      1,
      2,
    ]);
    expect(ProjectionStore.getProjection(key).threads[0].user?.text).toBe("snapshot");
    expect(
      ProjectionStore.getProjection(key).threads[0].assistantSegments[0]?.text,
    ).toBe("new live");
    expect(ProjectionStore.getWatermark(key)).toEqual({
      stream: "ledger-store",
      seq: 11,
    });
  });

  it("preserves an admitted live tail when the snapshot cursor predates beginSnapshot", () => {
    const key = ProjectionStore.projectionStoreKey("session-store");
    ProjectionStore.ingest(
      key,
      frame(1, user("snapshot user"), {
        cursor: 10,
        clientMessageId: "cmid-snapshot-user",
      }),
    );
    // This arrives after the server's eventual snapshot point, but before
    // the runtime gets to begin the snapshot transition after session/open.
    ProjectionStore.ingest(key, frame(2, delta("already live"), { cursor: 11 }));
    ProjectionStore.beginSnapshot(key, ProjectionStore.getWatermark(key));

    ProjectionStore.replaceSnapshot(
      key,
      [
        frame(1, user("snapshot user"), {
          cursor: 10,
          clientMessageId: "cmid-snapshot-user",
        }),
      ],
      { stream: "ledger-store", seq: 10 },
    );

    expect(ProjectionStore.getEnvelopes(key).map((entry) => entry.seq)).toEqual([
      1,
      2,
    ]);
    expect(
      ProjectionStore.getProjection(key).threads[0].assistantSegments[0]?.text,
    ).toBe("already live");
    expect(ProjectionStore.getWatermark(key)).toEqual({
      stream: "ledger-store",
      seq: 11,
    });
  });

  it("does not discard the live buffer when overlapping hydrate requests begin", () => {
    const key = ProjectionStore.projectionStoreKey("session-store");
    ProjectionStore.beginSnapshot(key, { stream: "ledger-store", seq: 10 });
    ProjectionStore.ingest(key, frame(2, delta("live after snapshot"), { cursor: 12 }));

    // A reconnect and a gap recovery can both ask for a snapshot. The second
    // begin must leave the first request's live buffer intact.
    ProjectionStore.beginSnapshot(key, { stream: "ledger-store", seq: 10 });
    ProjectionStore.replaceSnapshot(
      key,
      [
        frame(1, user("snapshot"), {
          cursor: 11,
          clientMessageId: "cmid-snapshot",
        }),
      ],
      { stream: "ledger-store", seq: 11 },
    );

    expect(ProjectionStore.getEnvelopes(key).map((entry) => entry.seq)).toEqual([
      1,
      2,
    ]);
  });

  it("does not advance a snapshot watermark across a gap or discard its buffered repair", () => {
    const key = ProjectionStore.projectionStoreKey("session-store");
    ProjectionStore.beginSnapshot(key, { stream: "ledger-store", seq: 10 });
    // This frame is already at/before the snapshot watermark. It must still
    // be replayed when the snapshot itself has a hole at seq 1.
    ProjectionStore.ingest(
      key,
      frame(1, user("buffered repair"), {
        cursor: 10,
        clientMessageId: "cmid-buffered-repair",
      }),
    );

    ProjectionStore.replaceSnapshot(
      key,
      [frame(2, delta("snapshot second"), { cursor: 11 })],
      { stream: "ledger-store", seq: 11 },
    );

    expect(ProjectionStore.getEnvelopes(key).map((entry) => entry.seq)).toEqual([
      1,
      2,
    ]);
    expect(ProjectionStore.getProjection(key).threads[0].user?.text).toBe(
      "buffered repair",
    );
    expect(ProjectionStore.getWatermark(key)).toEqual({
      stream: "ledger-store",
      seq: 11,
    });
  });

  it("announces a terminal replayed from the live snapshot buffer", () => {
    const key = ProjectionStore.projectionStoreKey("session-store");
    const admitted = vi.fn();
    const dispose = ProjectionStore.onEnvelopeAdmitted(admitted);
    ProjectionStore.beginSnapshot(key, { stream: "ledger-store", seq: 10 });
    ProjectionStore.ingest(
      key,
      frame(1, user("live user"), {
        cursor: 11,
        clientMessageId: "cmid-live",
      }),
    );
    ProjectionStore.ingest(
      key,
      frame(2, {
        type: "turn_terminal",
        data: { outcome: "errored", error: { code: "failed", message: "nope" } },
      }, { cursor: 12 }),
    );

    ProjectionStore.replaceSnapshot(key, [], { stream: "ledger-store", seq: 10 });

    expect(admitted).toHaveBeenCalledWith(
      key,
      expect.objectContaining({
        seq: 2,
        payload: expect.objectContaining({ type: "turn_terminal" }),
      }),
    );
    dispose();
  });

  it("resets a canonical scope without selecting another render mode", () => {
    const key = ProjectionStore.projectionStoreKey("session-store", "topic-a");
    ProjectionStore.ingest(key, frame(1, user("question"), { cursor: 1 }));
    expect(ProjectionStore.getEnvelopes(key)).toHaveLength(1);

    ProjectionStore.resetProjectionScope("session-store", "topic-a");

    expect(ProjectionStore.getEnvelopes(key)).toEqual([]);
  });
});
