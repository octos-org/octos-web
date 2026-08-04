import { afterEach, describe, expect, it } from "vitest";
import type {
  ProjectionEnvelopeV2,
  ProjectionEnvelopeV2Payload,
} from "@/runtime/projection-envelope-v2";
import * as ProjectionStore from "./projection-store";
import { getRenderThreads } from "./projection-render-adapter";
import * as ThreadStore from "./thread-store";

const sessionId = "session-render";
const topic = "topic-render";

function frame(seq: number, payload: ProjectionEnvelopeV2Payload): ProjectionEnvelopeV2 {
  return {
    session_id: sessionId,
    topic,
    thread_id: "thread-render",
    turn_id: "turn-render",
    seq,
    cursor: { stream: "ledger-render", seq },
    ...(seq === 1 ? { client_message_id: "cmid-render" } : {}),
    payload,
  };
}

afterEach(() => {
  ProjectionStore.__resetProjectionForTests();
  ThreadStore.__resetForTests();
});

describe("projection render adapter", () => {
  it("never exposes ThreadStore rows", () => {
    ThreadStore.addUserMessage(sessionId, {
      text: "legacy row must not flash",
      clientMessageId: "legacy-cmid",
      files: [],
      topic,
    });

    ProjectionStore.resetProjectionScope(sessionId, topic);
    expect(getRenderThreads(sessionId, topic)).toEqual([]);
  });

  it("renders only canonical segments and preserves a terminal failure", () => {
    const key = ProjectionStore.projectionStoreKey(sessionId, topic);
    const frames: ProjectionEnvelopeV2[] = [
      frame(1, {
        type: "user_message",
        data: { text: "question", files: [] },
      }),
      frame(2, {
        type: "assistant_persisted",
        data: {
          assistant_segment_id: "segment-one",
          text: "first answer",
          meta: { message_id: "message-one", persisted_at: "2026-07-18T22:10:00Z" },
        },
      }),
      frame(3, {
        type: "assistant_persisted",
        data: {
          assistant_segment_id: "segment-two",
          text: "second answer",
          meta: { message_id: "message-two", persisted_at: "2026-07-18T22:10:01Z" },
        },
      }),
      frame(4, {
        type: "turn_terminal",
        data: {
          outcome: "errored",
          error: { code: "provider_error", message: "Provider stopped." },
        },
      }),
    ];
    for (const entry of frames) ProjectionStore.ingest(key, entry);

    const [thread] = getRenderThreads(sessionId, topic);
    expect(ThreadStore.getThreads(sessionId, topic)).toEqual([]);
    expect(thread.id).toBe("cmid-render");
    expect(thread.turnId).toBe("turn-render");
    expect(thread.responses.map((response) => response.text)).toEqual([
      "first answer",
      "second answer",
      "Provider stopped.",
    ]);
    expect(thread.responses.map((response) => response.status)).toEqual([
      "complete",
      "complete",
      "error",
    ]);
    expect(thread.pendingAssistant).toBeNull();
  });

  it("keeps a background completion as a linked child stream, not a parent response", () => {
    const key = ProjectionStore.projectionStoreKey(sessionId, topic);
    ProjectionStore.ingest(key, frame(1, {
      type: "user_message",
      data: { text: "start a background task", files: [] },
    }));
    ProjectionStore.ingest(key, frame(2, {
      type: "turn_terminal",
      data: { outcome: "completed" },
    }));
    ProjectionStore.ingest(key, {
      session_id: sessionId,
      topic,
      thread_id: "thread-render:child:task-1",
      turn_id: "turn-render:child:task-1",
      seq: 1,
      cursor: { stream: "ledger-render", seq: 3 },
      payload: {
        type: "background/spawn_complete",
        data: {
          parent_turn_id: "turn-render",
          response_to_client_message_id: "cmid-render",
          task_id: "task-1",
          content: "Background result",
        },
      },
    });

    const threads = getRenderThreads(sessionId, topic);
    const parent = threads.find((thread) => thread.id === "cmid-render")!;
    const child = threads.find((thread) => thread.backgroundChild)!;

    expect(parent.responses).toEqual([]);
    expect(child).toMatchObject({
      turnId: "turn-render:child:task-1",
      parentTurnId: "turn-render",
      responseToClientMessageId: "cmid-render",
    });
    expect(child.responses.map((message) => message.text)).toEqual([
      "Background result",
    ]);
  });
});
