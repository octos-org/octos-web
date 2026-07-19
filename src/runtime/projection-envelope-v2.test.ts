import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseProjectionEnvelopeV2,
  type ProjectionEnvelopeV2,
} from "./projection-envelope-v2";

const fixtureDirectory = resolve(__dirname, "fixtures/projection-envelope-v2");
const fixtureNames = [
  "user-message.json",
  "assistant-delta.json",
  "assistant-persisted-with-media.json",
  "tool-outcome.json",
  "terminal-error.json",
  "background-spawn-complete.json",
  "reconnect-cursor.json",
] as const;

function readFixture(name: (typeof fixtureNames)[number]): unknown {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, name), "utf8")) as unknown;
}

function parseFixture(name: (typeof fixtureNames)[number]): ProjectionEnvelopeV2 {
  const parsed = parseProjectionEnvelopeV2(readFixture(name));
  if (!parsed.ok) {
    throw new Error(`${name}: ${parsed.error.path}: ${parsed.error.message}`);
  }
  return parsed.value;
}

describe("projection.envelope.v2 parser", () => {
  it.each(fixtureNames)("decodes flattened Stage 1 frame %s", (name) => {
    const frame = parseFixture(name);
    expect(frame.seq).toBeGreaterThanOrEqual(1);
    expect(frame.turn_id).not.toBe("");
    expect(frame.cursor).toMatchObject({ stream: "session-capture-001" });
  });

  it("preserves assistant segment identities, explicit terminal state, and child linkage", () => {
    const delta = parseFixture("assistant-delta.json");
    const persisted = parseFixture("assistant-persisted-with-media.json");
    const terminal = parseFixture("terminal-error.json");
    const child = parseFixture("background-spawn-complete.json");

    expect(delta.payload).toEqual({
      type: "assistant_delta",
      data: {
        assistant_segment_id: "segment-capture-001",
        text: "I will start by identifying the major flows.",
      },
    });
    expect(persisted.payload).toMatchObject({
      type: "assistant_persisted",
      data: {
        assistant_segment_id: "segment-capture-001",
        meta: { message_id: "msg-capture-003" },
      },
    });
    expect(terminal.payload).toMatchObject({
      type: "turn_terminal",
      data: { outcome: "errored" },
    });
    expect(child).toMatchObject({
      thread_id: "turn-capture-001:background:task-capture-001",
      turn_id: "turn-capture-001:background:task-capture-001",
      payload: {
        type: "background/spawn_complete",
        data: {
          parent_turn_id: "turn-capture-001",
          response_to_client_message_id: "cmid-capture-001",
        },
      },
    });
  });

  it("keeps the ledger cursor separate from the per-thread sequence", () => {
    const replay = parseFixture("reconnect-cursor.json");
    expect(replay.seq).toBe(1);
    expect(replay.cursor).toEqual({
      stream: "session-capture-001",
      seq: 412,
    });
  });

  it("normalizes direct attachment ownership onto its segment or tool id", () => {
    const parsed = parseProjectionEnvelopeV2({
      session_id: "session-capture-001",
      thread_id: "thread-capture-001",
      turn_id: "turn-capture-001",
      seq: 6,
      cursor: { stream: "session-capture-001", seq: 106 },
      payload: {
        type: "file_attached",
        data: {
          path: "artifacts/result.md",
          mime: "text/markdown",
          size_bytes: 42,
          assistant_segment_id: "segment-capture-001",
          tool_call_id: "call-capture-001",
        },
      },
    });
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        payload: {
          type: "file_attached",
          data: {
            assistant_segment_id: "segment-capture-001",
            tool_call_id: "call-capture-001",
          },
        },
      },
    });
  });

  it("is pure and rejects seq zero, nested frames, and incomplete v2 identity", () => {
    const fixture = readFixture("user-message.json") as Record<string, unknown>;
    const before = JSON.stringify(fixture);
    expect(parseProjectionEnvelopeV2(fixture)).toEqual(
      parseProjectionEnvelopeV2(fixture),
    );
    expect(JSON.stringify(fixture)).toBe(before);

    const zero = { ...fixture, seq: 0 };
    expect(parseProjectionEnvelopeV2(zero)).toMatchObject({
      ok: false,
      error: { path: "$.seq" },
    });
    expect(parseProjectionEnvelopeV2({ envelope: fixture })).toMatchObject({
      ok: false,
      error: { path: "$.session_id" },
    });
    const noTurn = { ...fixture };
    delete noTurn.turn_id;
    expect(parseProjectionEnvelopeV2(noTurn)).toMatchObject({
      ok: false,
      error: { path: "$.turn_id" },
    });
    const noSegment = {
      ...readFixture("assistant-delta.json") as Record<string, unknown>,
      payload: {
        type: "assistant_delta",
        data: { text: "missing segment" },
      },
    };
    expect(parseProjectionEnvelopeV2(noSegment)).toMatchObject({
      ok: false,
      error: { path: "$.payload.data.assistant_segment_id" },
    });
    const childWithoutResponse = {
      ...readFixture("background-spawn-complete.json") as Record<string, unknown>,
      payload: {
        type: "background/spawn_complete",
        data: {
          parent_turn_id: "turn-capture-001",
          task_id: "task-capture-001",
          content: "Background result",
        },
      },
    };
    expect(parseProjectionEnvelopeV2(childWithoutResponse)).toMatchObject({
      ok: false,
      error: { path: "$.payload.data.response_to_client_message_id" },
    });
  });
});
