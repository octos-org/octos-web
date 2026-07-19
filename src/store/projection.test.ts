import { describe, expect, it } from "vitest";
import type {
  ProjectionEnvelopeV2,
  ProjectionEnvelopeV2Payload,
} from "../runtime/projection-envelope-v2";
import { project, projectWithMetrics } from "./projection";

const SESSION = "session-projection";
const TURN = "turn-parent";

function envelope(
  seq: number,
  payload: ProjectionEnvelopeV2Payload,
  options: {
    threadId?: string;
    turnId?: string;
    clientMessageId?: string;
    cursor?: number;
  } = {},
): ProjectionEnvelopeV2 {
  return {
    session_id: SESSION,
    thread_id: options.threadId ?? "thread-parent",
    turn_id: options.turnId ?? TURN,
    seq,
    cursor: { stream: "ledger-parent", seq: options.cursor ?? seq },
    ...(options.clientMessageId
      ? { client_message_id: options.clientMessageId }
      : {}),
    payload,
  };
}

const meta = (id: string) => ({
  message_id: id,
  persisted_at: "2026-07-18T22:10:00Z",
});

describe("canonical projection v2", () => {
  it("keeps each assistant segment as a distinct bubble and preserves attachment ownership", () => {
    const view = project([
      envelope(1, {
        type: "user_message",
        data: { text: "Investigate this.", files: [] },
      }, { clientMessageId: "cmid-parent" }),
      envelope(2, {
        type: "assistant_delta",
        data: { assistant_segment_id: "segment-a", text: "First " },
      }),
      envelope(3, {
        type: "assistant_persisted",
        data: {
          assistant_segment_id: "segment-a",
          text: "First answer",
          meta: meta("message-a"),
        },
      }),
      envelope(4, {
        type: "tool_start",
        data: { tool_call_id: "tool-a", name: "workspace.search" },
      }),
      envelope(5, {
        type: "tool_end",
        data: { tool_call_id: "tool-a", status: "complete" },
      }),
      envelope(6, {
        type: "assistant_delta",
        data: { assistant_segment_id: "segment-b", text: "Second " },
      }),
      envelope(7, {
        type: "assistant_persisted",
        data: {
          assistant_segment_id: "segment-b",
          text: "Second answer",
          meta: meta("message-b"),
        },
      }),
      // This deliberately arrives after segment B: ownership must not fall
      // back to the most-recent assistant bubble.
      envelope(8, {
        type: "file_attached",
        data: {
          path: "artifacts/first.md",
          mime: "text/markdown",
          size_bytes: 42,
          assistant_segment_id: "segment-a",
        },
      }),
      envelope(9, {
        type: "file_attached",
        data: {
          path: "artifacts/tool.log",
          mime: "text/plain",
          size_bytes: 9,
          tool_call_id: "tool-a",
        },
      }),
      envelope(10, {
        type: "turn_terminal",
        data: { outcome: "completed", token_usage: { output_tokens: 12 } },
      }),
    ]);

    const thread = view.threads[0];
    expect(thread.assistantSegments.map((segment) => segment.assistant_segment_id)).toEqual([
      "segment-a",
      "segment-b",
    ]);
    expect(thread.assistantSegments.map((segment) => segment.text)).toEqual([
      "First answer",
      "Second answer",
    ]);
    expect(thread.assistantSegments[0].files.map((file) => file.path)).toEqual([
      "artifacts/first.md",
    ]);
    expect(thread.assistantSegments[1].files).toEqual([]);
    expect(thread.assistantSegments[0].toolCalls[0]).toMatchObject({
      tool_call_id: "tool-a",
      status: "complete",
      files: [{ path: "artifacts/tool.log" }],
    });
    expect(thread.assistantSegments[1].toolCalls).toEqual([]);
    expect(thread.terminal).toMatchObject({
      outcome: "completed",
      tokenUsage: { output_tokens: 12 },
    });
  });

  it.each([
    ["errored", "provider stopped"],
    ["interrupted", "cancelled by user"],
  ] as const)("represents %s terminal outcomes", (outcome, message) => {
    const thread = project([
      envelope(1, {
        type: "user_message",
        data: { text: "run", files: [] },
      }, { clientMessageId: "cmid-terminal" }),
      envelope(2, {
        type: "turn_terminal",
        data: {
          outcome,
          error: { code: outcome, message },
        },
      }),
    ]).threads[0];

    expect(thread.terminal).toEqual({
      outcome,
      error: { code: outcome, message },
      tokenUsage: null,
      seq: 2,
    });
  });

  it("keeps a background completion in its linked child stream after the parent terminal", () => {
    const view = project([
      envelope(1, {
        type: "user_message",
        data: { text: "start background work", files: [] },
      }, { clientMessageId: "cmid-parent" }),
      envelope(2, {
        type: "turn_terminal",
        data: { outcome: "completed" },
      }),
      envelope(
        1,
        {
          type: "background/spawn_complete",
          data: {
            parent_turn_id: TURN,
            response_to_client_message_id: "cmid-parent",
            task_id: "task-child",
            content: "Background result",
            message_id: "message-child",
            source: "background",
            persisted_at: "2026-07-18T22:11:00Z",
            media: ["artifacts/background.md"],
          },
        },
        { threadId: "thread-child", turnId: "turn-child", cursor: 3 },
      ),
    ]);

    const parent = view.threads.find((thread) => thread.turn_id === TURN)!;
    const child = view.threads.find((thread) => thread.turn_id === "turn-child")!;
    expect(parent.terminal?.outcome).toBe("completed");
    expect(parent.assistantSegments).toEqual([]);
    expect(child.backgroundChild).toMatchObject({
      parent_turn_id: TURN,
      response_to_client_message_id: "cmid-parent",
      content: "Background result",
    });
  });

  it("deduplicates by thread and sequence and rejects parent events after terminal", () => {
    const result = projectWithMetrics([
      envelope(1, {
        type: "user_message",
        data: { text: "hello", files: [] },
      }),
      envelope(2, {
        type: "assistant_delta",
        data: { assistant_segment_id: "segment-a", text: "hi" },
      }),
      envelope(2, {
        type: "assistant_delta",
        data: { assistant_segment_id: "segment-a", text: "duplicate" },
      }),
      envelope(3, {
        type: "turn_terminal",
        data: { outcome: "completed" },
      }),
      envelope(4, {
        type: "assistant_delta",
        data: { assistant_segment_id: "segment-b", text: "late" },
      }),
    ]);

    expect(result.view.threads[0].assistantSegments[0].text).toBe("hi");
    expect(result.metrics).toEqual({
      duplicates: 1,
      droppedAfterTerminal: 1,
      outOfOrder: 0,
    });
  });
});
