import { describe, expect, it } from "vitest";
import {
  buildLearningSessionContext,
  buildLearningTurnContext,
  stripLearningContext,
} from "./learning-context";

describe("learning context protocol", () => {
  it("builds the v3 wake-session marker", () => {
    expect(
      buildLearningSessionContext({
        sessionId: "learn-1",
        entry: "wake-word",
        provisional: true,
      }),
    ).toContain(
      "version: 3\nsession_id: learn-1\nentry: wake-word\nprovisional: true",
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
});
