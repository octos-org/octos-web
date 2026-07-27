import { describe, expect, it } from "vitest";
import { parseLessonPacket } from "./lesson-packet";
import { buildAssistantLessonPacket } from "./assistant-to-board";

describe("assistant reply whiteboard fallback", () => {
  it("writes the learner problem, explanation, and formulas onto the board", () => {
    const packet = buildAssistantLessonPacket({
      id: "turn-1",
      userText: "把 y = x² + 6x + 5 配方，并说出顶点。",
      assistantText:
        "第一步：先看 $x^2 + 6x$。配方公式是 $(x+b)^2=x^2+2bx+b^2$。\n\n所以得到 $y=(x+3)^2-4$。",
    });

    expect(packet).not.toBeNull();
    expect(parseLessonPacket(packet).packet).not.toBeNull();
    expect(
      packet?.segments.flatMap((segment) => segment.actions),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "write_text", text: expect.stringContaining("配方") }),
        expect.objectContaining({ type: "write_formula", latex: "x^2 + 6x" }),
        expect.objectContaining({ type: "write_formula", latex: "y=(x+3)^2-4" }),
      ]),
    );
  });

  it("does not create a lesson before an assistant reply exists", () => {
    expect(
      buildAssistantLessonPacket({
        id: "turn-2",
        userText: "一道题",
        assistantText: "   ",
      }),
    ).toBeNull();
  });

  it("writes only the mathematical problem instead of the learner's UI instructions", () => {
    const packet = buildAssistantLessonPacket({
      id: "turn-real",
      userText:
        "请在白板上讲解函数 \\(y=x^2+6x+5\\)。不要直接给答案，先用配方法。",
      assistantText: "先把二次项和一次项放在一起。",
    });
    const actions = packet?.segments.flatMap((segment) => segment.actions);

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "write_formula",
          latex: "y=x^2+6x+5",
        }),
      ]),
    );
    expect(
      actions?.some(
        (action) => action.type === "write_text" && action.text.includes("不要直接"),
      ),
    ).toBe(false);
  });
});
