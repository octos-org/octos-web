import { describe, expect, it } from "vitest";
import { buildAssistantLessonPacket } from "./assistant-to-board";
import {
  buildLearningBoardContext,
  mergeSessionBoardPackets,
} from "./session-board";

describe("session learning board", () => {
  it("keeps the first explanation when a follow-up turn is appended", () => {
    const first = buildAssistantLessonPacket(
      {
        id: "turn-1",
        userText: "请讲解函数 \\(y=x^2+6x+5\\)。",
        assistantText:
          "第一步：配方。$x^2+6x+5=(x+3)^2-4$。接着得到顶点 $(-3,-4)$。",
      },
      { includeProblem: true, origin: { x: 120, y: 80 } },
    );
    const followUp = buildAssistantLessonPacket(
      {
        id: "turn-2",
        userText: "不知道",
        assistantText:
          "这里直接继续展开：$(x+3)^2=x^2+6x+9$，所以需要减去 $4$。",
      },
      { includeProblem: false, origin: { x: 880, y: 120 } },
    );
    const packet = mergeSessionBoardPackets(
      "learn-real-case",
      [first, followUp].filter((value) => value !== null),
    );
    const actions = packet.segments.flatMap((segment) => segment.actions);

    expect(packet.lessonId).toBe("learn-real-case");
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "write_formula",
          latex: "y=x^2+6x+5",
        }),
        expect.objectContaining({
          type: "write_formula",
          latex: "(x+3)^2=x^2+6x+9",
        }),
      ]),
    );
    expect(
      actions.some(
        (action) => action.type === "write_text" && action.text === "不知道",
      ),
    ).toBe(false);
  });

  it("builds only minimal continuity context from visible board content", () => {
    const packet = mergeSessionBoardPackets("learn-1", [
      buildAssistantLessonPacket({
        id: "turn-1",
        userText: "函数 \\(y=x^2+6x+5\\)",
        assistantText: "配方后得到 $y=(x+3)^2-4$。",
      })!,
    ]);

    expect(buildLearningBoardContext(packet)).toEqual({
      lastAppliedAction: expect.any(String),
      boardSummary: expect.stringContaining("y=(x+3)^2-4"),
    });
  });
});
