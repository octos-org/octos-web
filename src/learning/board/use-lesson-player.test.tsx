import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LessonPacketV1 } from "./lesson-packet";
import { useLessonPlayer } from "./use-lesson-player";

function packet(segmentIds: string[]): LessonPacketV1 {
  return {
    version: 1,
    lessonId: "learn-continuous",
    turnId: segmentIds.at(-1) ?? "empty",
    title: "连续白板",
    segments: segmentIds.map((id) => ({
      id,
      speech: id,
      actions: [
        {
          id: `${id}-text`,
          type: "write_text",
          text: id,
          at: { x: 100, y: 100 },
        },
      ],
    })),
  };
}

describe("useLessonPlayer", () => {
  it("starts at the first new segment when a turn is appended", async () => {
    const { result, rerender } = renderHook(
      ({ value }) => useLessonPlayer(value, true),
      { initialProps: { value: packet(["old-1", "old-2"]) } },
    );

    expect(result.current.segmentIndex).toBe(0);
    rerender({ value: packet(["old-1", "old-2", "new-1", "new-2"]) });

    await waitFor(() => expect(result.current.segmentIndex).toBe(2));
    expect(result.current.activeSpeech).toBe("new-1");
  });
});
