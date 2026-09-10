import { describe, expect, it } from "vitest";
import { buildVoiceTurns } from "@/home/voice/use-voice-conversation";
import { projectionToRenderThreads } from "@/store/projection-render-adapter";
import { project } from "@/store/projection";
import * as ProjectionStore from "@/store/projection-store";
import type { ProjectionEnvelopeV2 } from "./projection-envelope-v2";
import { hydrateProjectionEnvelopes } from "./hydrate-projection";

describe("hydrateProjectionEnvelopes", () => {
  it("restores the real direct-voice Learn hydrate shape without browser state", () => {
    const sessionId = "learn-1787398124712-u9i7c0";
    const turnId = "a9975c2c-cd54-4a3a-b773-6c4d110ccd97";
    const envelopes = hydrateProjectionEnvelopes(sessionId, undefined, {
      session_id: sessionId,
      cursor: { stream: sessionId, seq: 541 },
      messages: [
        {
          seq: 0,
          role: "user",
          content: [
            "[[LEARNING_SESSION]]",
            "version: 4",
            `session_id: ${sessionId}`,
            "entry: direct",
            "provisional: true",
            "[[/LEARNING_SESSION]]",
            "[[LEARNING_CONTEXT]]",
            "active: true",
            `session_id: ${sessionId}`,
            `turn_id: ${turnId}`,
            "[[/LEARNING_CONTEXT]]",
            "自然对数意义是怎么推导的？",
          ].join("\n"),
          thread_id: turnId,
          persisted_at: "2026-08-22T11:29:12.808855Z",
          media: ["uploads/utterance.wav"],
        },
        {
          seq: 1,
          role: "assistant",
          content: "课程已经放到白板上啦。",
          thread_id: turnId,
          persisted_at: "2026-08-22T11:29:52.754669Z",
          message_id: "assistant-row-1",
        },
      ],
      replayed_envelopes: [],
      replayed_tool_envelopes: [],
    });

    expect(envelopes).not.toBeNull();
    const threads = projectionToRenderThreads(project(envelopes ?? []));
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(turnId);
    expect(buildVoiceTurns(threads)[0]).toMatchObject({
      id: turnId,
      userText: "自然对数意义是怎么推导的？",
      assistantText: "课程已经放到白板上啦。",
    });
  });

  it("prefers a canonical projection snapshot when the server supplies one", () => {
    const envelopes = hydrateProjectionEnvelopes("session-a", undefined, {
      session_id: "session-a",
      cursor: { stream: "session-a", seq: 1 },
      messages: [],
      projection_snapshot: {
        cursor: { stream: "session-a", seq: 1 },
        envelopes: [{
          session_id: "session-a",
          thread_id: "thread-a",
          turn_id: "turn-a",
          seq: 1,
          payload: {
            type: "user_message",
            data: { text: "canonical", files: [] },
          },
        }],
      },
    });

    expect(envelopes).toHaveLength(1);
    expect(envelopes?.[0].payload).toMatchObject({
      type: "user_message",
      data: { text: "canonical" },
    });
  });
});


it("keeps a live thread's sequence through transcript hydration and admits its next terminal", () => {
  ProjectionStore.__resetProjectionForTests();
  const session = "recorded-live";
  const retained: ProjectionEnvelopeV2[] = Array.from({ length: 7 }, (_, index) => ({
    session_id: session, thread_id: "turn", turn_id: "turn", seq: index + 1,
    cursor: { stream: session, seq: index + 7 },
    payload: { type: "assistant_delta", data: { text: "a", assistant_segment_id: "segment" } },
  }));
  retained.push({ session_id: session, thread_id: "turn", turn_id: "turn", seq: 8,
    cursor: { stream: session, seq: 16 }, payload: { type: "user_message", data: { text: "hello", files: [] } } });
  retained.push({ session_id: session, thread_id: "turn", turn_id: "turn", seq: 9,
    cursor: { stream: session, seq: 18 }, payload: { type: "assistant_persisted", data: {
      text: "answer", assistant_segment_id: "segment", meta: { message_id: "answer", persisted_at: "2026-09-10T23:10:39Z" },
    } } });
  const envelopes = hydrateProjectionEnvelopes(session, undefined, {
    session_id: session, cursor: { stream: session, seq: 18 },
    messages: [
      { seq: 0, thread_id: "older", role: "user", content: "old question", persisted_at: "2026-09-09T23:00:00Z" },
      { seq: 1, thread_id: "turn", role: "user", content: "hello", persisted_at: "2026-09-10T23:10:38Z" },
      { seq: 2, thread_id: "turn", role: "assistant", content: "answer", persisted_at: "2026-09-10T23:10:39Z" },
    ],
    // Core's typed retained carrier omits the redundant session routing keys.
    replayed_projection_envelopes: retained.map((entry) => { const wire: Partial<ProjectionEnvelopeV2> = { ...entry }; delete wire.session_id; return wire; }),
  })!;
  expect(envelopes.filter((entry) => entry.thread_id === "turn").map((entry) => entry.seq)).toEqual([1,2,3,4,5,6,7,8,9]);
  ProjectionStore.beginSnapshot(session);
  ProjectionStore.replaceSnapshot(session, envelopes, { stream: session, seq: 18 });
  const result = ProjectionStore.ingest(session, { session_id: session, thread_id: "turn", turn_id: "turn", seq: 10,
    cursor: { stream: session, seq: 19 }, payload: { type: "turn_terminal", data: { outcome: "completed" } } });
  expect(result.accepted).toBe(true);
  const threads = ProjectionStore.getProjection(session).threads;
  expect(threads.find((thread) => thread.thread_id === "turn")?.terminal?.outcome).toBe("completed");
  expect(projectionToRenderThreads({ threads }).find((thread) => thread.turnId === "turn")?.userMsg.timestamp).toBe(Date.parse("2026-09-10T23:10:38Z"));
  expect(threads.some((thread) => thread.thread_id === "older")).toBe(true);
  ProjectionStore.__resetProjectionForTests();
});
