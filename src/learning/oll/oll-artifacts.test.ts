import { describe, expect, it, vi } from "vitest";
import type { Thread } from "@/store/thread-store";
import {
  buildOllLessonTopics,
  collectPersistedOllLessonArtifacts,
  collectOllLessonArtifacts,
  composeOllClassroomEvents,
  isOllLessonArtifact,
  loadOllLessonArtifact,
  mergeOllLessonArtifacts,
  ollArtifactIdentity,
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

const threeStepAuthoringLesson = {
  ...authoringLesson,
  steps: ["first", "second", "third"].map((key) => ({
    key,
    purpose: `讲解 ${key}`,
    beats: [{
      key: `write-${key}`,
      say: `讲解 ${key}。`,
      actions: [{
        do: "write",
        as: `answer-${key}`,
        kind: "note",
        role: "conclusion",
        content: { text: `结论 ${key}` },
        place: { relation: "new_region", region_role: "lesson_origin" },
      }],
    }],
  })),
  close: { summary: "完成三步讲解", focus: ["answer-third"] },
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
    const artifactIdentity = ollArtifactIdentity(artifact!);
    expect(events[0]?.board?.region_id).toBe(`topic-${artifactIdentity}`);
    const createdNode = events[1]?.step?.beats
      .flatMap((beat) => Object.values(beat.stage).flat())
      .find((action) => action.op === "board.create")?.node;
    expect(createdNode?.region_id).toBe(`topic-${artifactIdentity}`);
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
    const secondArtifact = {
      ...artifact!,
      filename: "turn-2.octos-lesson.json",
      path: "study/oll/turn-2.octos-lesson.json",
      turnId: "server-turn-2",
    };
    const second = await loadOllLessonArtifact(secondArtifact, "session-1");
    const firstClassroom = composeOllClassroomEvents([first], "session-1");
    const classroom = composeOllClassroomEvents([first, second], "session-1");
    expect(classroom.map((event) => event.event)).toEqual([
      "lesson.open",
      "lesson.step",
      "lesson.step",
    ]);
    expect(classroom.map((event) => event.sequence)).toEqual([0, 1, 2]);
    expect(new Set(classroom.map((event) => event.lesson_id)).size).toBe(1);
    expect(classroom[1]?.step?.id).not.toBe(classroom[2]?.step?.id);
    expect(classroom.slice(0, firstClassroom.length)).toEqual(firstClassroom);
    expect(buildOllLessonTopics([first, second])).toEqual([
      {
        id: first[0]?.board?.region_id,
        title: first[0]?.lesson?.title,
        stepIds: [first[1]?.step?.id],
      },
      {
        id: second[0]?.board?.region_id,
        title: second[0]?.lesson?.title,
        stepIds: [second[1]?.step?.id],
      },
    ]);
    const createdRegions = classroom.slice(1).map((event) =>
      event.step?.beats
        .flatMap((beat) => Object.values(beat.stage).flat())
        .find((action) => action.op === "board.create")?.node?.region_id,
    );
    expect(createdRegions).toEqual([
      `topic-${ollArtifactIdentity(artifact!)}`,
      `topic-${ollArtifactIdentity(secondArtifact)}`,
    ]);
    vi.unstubAllGlobals();
  });

  it("normalizes absolute live paths and persisted handles identically", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => authoringLesson,
    }));
    const filename = "ce3a5e4c-3ae4-4c8b-9c3f-fbe8eb4fc56b.octos-lesson.json";
    const live = await loadOllLessonArtifact({
      id: `live:${filename}`,
      filename,
      path: `/Users/learner/.octos/profiles/default/data/users/session/workspace/skill-output/study/oll/${filename}`,
      threadId: "client-turn",
      turnId: "server-turn-id",
    }, "session-1");
    const restored = await loadOllLessonArtifact({
      id: `persisted:${filename}`,
      filename,
      path: `pf/cHJvZmlsZS1yZWxhdGl2ZS1wYXRo/${filename}`,
      threadId: filename,
      turnId: filename,
    }, "session-1");

    expect(restored).toEqual(live);
    vi.unstubAllGlobals();
  });

  it("deduplicates one artifact delivered through live and persisted paths", () => {
    const filename = "same-turn.octos-lesson.json";
    const persisted = {
      id: `persisted:${filename}`,
      filename,
      path: `pf/b3BhcXVl/${filename}`,
      threadId: "same-turn",
      turnId: "same-turn",
    };
    const live = {
      id: `live:${filename}`,
      filename,
      path: `/profile/session/workspace/study/oll/${filename}`,
      threadId: "client-turn",
      turnId: "server-turn",
    };

    expect(mergeOllLessonArtifacts([persisted], [live])).toEqual([persisted]);
    expect(mergeOllLessonArtifacts([], [live])).toEqual([live]);
  });

  it("keeps sequence 7 stable when the third lesson changes path source after refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => threeStepAuthoringLesson,
    }));
    const ref = (
      filename: string,
      path: string,
    ) => ({
      id: `${filename}:${path}`,
      filename,
      path,
      threadId: filename,
      turnId: filename,
    });
    const firstRef = ref(
      "first.octos-lesson.json",
      "pf/first/first.octos-lesson.json",
    );
    const secondRef = ref(
      "second.octos-lesson.json",
      "pf/second/second.octos-lesson.json",
    );
    const thirdFilename = "third.octos-lesson.json";
    const thirdLiveRef = ref(
      thirdFilename,
      `/profile/session/workspace/skill-output/study/oll/${thirdFilename}`,
    );
    const thirdRestoredRef = ref(
      thirdFilename,
      `pf/third/${thirdFilename}`,
    );
    const [first, second, thirdLive, thirdRestored] = await Promise.all([
      loadOllLessonArtifact(firstRef, "session-1"),
      loadOllLessonArtifact(secondRef, "session-1"),
      loadOllLessonArtifact(thirdLiveRef, "session-1"),
      loadOllLessonArtifact(thirdRestoredRef, "session-1"),
    ]);

    const liveClassroom = composeOllClassroomEvents(
      [first, second, thirdLive],
      "session-1",
    );
    const restoredClassroom = composeOllClassroomEvents(
      [first, second, thirdRestored],
      "session-1",
    );

    expect(liveClassroom[7]?.sequence).toBe(7);
    expect(restoredClassroom[7]).toEqual(liveClassroom[7]);
    expect(restoredClassroom).toEqual(liveClassroom);
    vi.unstubAllGlobals();
  });
});
