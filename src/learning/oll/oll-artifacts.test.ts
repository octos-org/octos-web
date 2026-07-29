import { describe, expect, it, vi } from "vitest";
import type { Thread } from "@/store/thread-store";
import {
  collectPersistedOllLessonArtifacts,
  collectOllLessonArtifacts,
  composeOllClassroomEvents,
  isOllLessonArtifact,
  loadOllLessonArtifact,
} from "./oll-artifacts";

function threadWithLesson(path: string): Thread {
  return {
    id: "client-turn-1",
    turnId: "server-turn-1",
    userMsg: {
      id: "user-1",
      role: "user",
      text: "讲解这道题",
      files: [],
      toolCalls: [],
      status: "complete",
      timestamp: 1,
    },
    responses: [{
      id: "assistant-1",
      role: "assistant",
      text: "我们开始。",
      files: [{ filename: "turn.octos-lesson.json", path }],
      toolCalls: [],
      status: "complete",
      timestamp: 2,
    }],
    pendingAssistant: null,
  };
}

const authoringLesson = {
  dsl: "octos.lesson",
  version: "0.1",
  profile: "authoring",
  lesson: {
    mode: "explain",
    language: "zh-CN",
    title: "测试课程",
    goals: ["解释一个概念"],
  },
  steps: [{
    key: "explain",
    purpose: "写出结论",
    beats: [{
      key: "write",
      say: "先写出核心结论。",
      actions: [{
        do: "write",
        as: "answer",
        kind: "note",
        role: "conclusion",
        content: { text: "核心结论" },
        place: { relation: "new_region", region_role: "lesson_origin" },
      }],
    }],
  }],
  close: { summary: "完成讲解", focus: ["answer"] },
};

describe("OLL lesson artifacts", () => {
  it("rebuilds artifact references from durable session files", () => {
    expect(
      collectPersistedOllLessonArtifacts([
        {
          filename: "turn-2.octos-lesson.json",
          path: "skill-output/study/oll/turn-2.octos-lesson.json",
          size_bytes: 200,
          modified_at: "2026-07-28T12:02:00.000Z",
        },
        {
          filename: "notes.txt",
          path: "notes.txt",
          size_bytes: 10,
          modified_at: "2026-07-28T12:00:00.000Z",
        },
        {
          filename: "turn-1.octos-lesson.json",
          path: "study/oll/turn-1.octos-lesson.json",
          size_bytes: 100,
          modified_at: "2026-07-28T12:01:00.000Z",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        path: "study/oll/turn-1.octos-lesson.json",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        path: "skill-output/study/oll/turn-2.octos-lesson.json",
        turnId: "turn-2",
      }),
    ]);
  });

  it("recognizes and collects delivered OLL authoring files", () => {
    expect(isOllLessonArtifact({ filename: "turn.OCTOS-LESSON.JSON" })).toBe(true);
    expect(isOllLessonArtifact({ filename: "turn.octos-board.json" })).toBe(false);
    expect(collectOllLessonArtifacts([
      threadWithLesson("study/oll/turn.octos-lesson.json"),
    ])).toEqual([
      expect.objectContaining({
        path: "study/oll/turn.octos-lesson.json",
        turnId: "server-turn-1",
      }),
    ]);
  });

  it("validates and normalizes an Authoring artifact before playback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => authoringLesson,
    }));
    const [artifact] = collectOllLessonArtifacts([
      threadWithLesson("study/oll/turn.octos-lesson.json"),
    ]);
    const events = await loadOllLessonArtifact(artifact!, "session-1");
    expect(events.map((event) => event.event)).toEqual([
      "lesson.open",
      "lesson.step",
      "lesson.close",
    ]);
    expect(events[1]?.step?.beats[0]?.narration?.text).toBe("先写出核心结论。");
    vi.unstubAllGlobals();
  });

  it("composes multiple teaching turns as one open incremental classroom", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => authoringLesson,
    }));
    const [artifact] = collectOllLessonArtifacts([
      threadWithLesson("study/oll/turn.octos-lesson.json"),
    ]);
    const first = await loadOllLessonArtifact(artifact!, "session-1");
    const second = await loadOllLessonArtifact(
      { ...artifact!, path: "study/oll/turn-2.octos-lesson.json", turnId: "server-turn-2" },
      "session-1",
    );
    const classroom = composeOllClassroomEvents([first, second], "session-1");
    expect(classroom.map((event) => event.event)).toEqual([
      "lesson.open",
      "lesson.step",
      "lesson.step",
    ]);
    expect(classroom.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(new Set(classroom.map((event) => event.lesson_id)).size).toBe(1);
    expect(classroom[1]?.step?.id).not.toBe(classroom[2]?.step?.id);
    vi.unstubAllGlobals();
  });
});
