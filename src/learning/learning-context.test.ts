import { describe, expect, it } from "vitest";
import {
  buildLearningSessionContext,
  buildLearningTurnContext,
  stripLearningContext,
} from "./learning-context";

describe("learning context protocol", () => {
  it("builds the v4 wake-session marker", () => {
    expect(
      buildLearningSessionContext({
        sessionId: "learn-1",
        entry: "wake-word",
        provisional: true,
      }),
    ).toContain(
      "version: 4\nsession_id: learn-1\nentry: wake-word\nprovisional: true",
    );
  });

  it("only includes current_frame when a frame was actually attached", () => {
    expect(
      buildLearningTurnContext({
        sessionId: "learn-1",
        currentFrame: "uploads/frame.jpg",
      }),
    ).toContain("current_frame: uploads/frame.jpg");
    expect(buildLearningTurnContext({ sessionId: "learn-1" })).not.toContain(
      "current_frame",
    );
  });

  it("strips protocol blocks from learner-visible text", () => {
    const text = `${buildLearningSessionContext({
      sessionId: "learn-1",
      entry: "direct",
      provisional: false,
    })}\n帮我看这道题`;
    expect(stripLearningContext(text)).toBe("帮我看这道题");
  });

  it("includes board-addressable turn context without exposing newlines", () => {
    const context = buildLearningTurnContext({
      sessionId: "learn-1",
      turnId: "turn-8",
      focusedElement: "formula-vertex",
      lastAppliedAction: "action-17",
      pendingGoal: "draw-parabola",
      boardSummary: "已完成配方\n尚未作图",
    });

    expect(context).toContain("turn_id: turn-8");
    expect(context).toContain("lesson_artifact_tool: oll_generate_lesson");
    expect(context).toContain("lesson_artifact_policy: tool_only");
    expect(context).toContain("direct_oll_json: forbidden");
    expect(context).toContain("focused_element: formula-vertex");
    expect(context).toContain("last_applied_action: action-17");
    expect(context).toContain("pending_goal: draw-parabola");
    expect(context).toContain("board_summary: 已完成配方 尚未作图");
  });
});
