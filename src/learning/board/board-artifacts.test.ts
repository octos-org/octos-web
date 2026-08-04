import { describe, expect, it } from "vitest";
import type { Thread } from "@/store/thread-store";
import {
  collectBoardArtifacts,
  isBoardArtifact,
} from "./board-artifacts";

function threadWithFiles(
  files: Array<{ filename: string; path: string }>,
): Thread {
  return {
    id: "client-turn-1",
    turnId: "server-turn-1",
    userMsg: {
      id: "user-1",
      role: "user",
      text: "帮我讲解",
      files: [],
      toolCalls: [],
      status: "complete",
      timestamp: 1,
    },
    responses: [
      {
        id: "assistant-1",
        role: "assistant",
        text: "我们先看第一步。",
        files,
        toolCalls: [],
        status: "complete",
        timestamp: 2,
      },
    ],
    pendingAssistant: null,
  };
}

describe("board artifacts", () => {
  it("recognizes the board artifact suffix by filename or path", () => {
    expect(
      isBoardArtifact({
        filename: "turn-1.octos-board.json",
        path: "study/board/opaque",
      }),
    ).toBe(true);
    expect(
      isBoardArtifact({
        filename: "opaque",
        path: "study/board/turn-1.OCTOS-BOARD.JSON",
      }),
    ).toBe(true);
    expect(
      isBoardArtifact({ filename: "lesson.json", path: "lesson.json" }),
    ).toBe(false);
  });

  it("collects and deduplicates board artifacts from assistant messages", () => {
    const threads = [
      threadWithFiles([
        {
          filename: "turn-1.octos-board.json",
          path: "study/board/turn-1.octos-board.json",
        },
        {
          filename: "notes.md",
          path: "study/notes.md",
        },
      ]),
    ];
    const artifacts = collectBoardArtifacts(threads);
    expect(artifacts).toEqual([
      expect.objectContaining({
        path: "study/board/turn-1.octos-board.json",
        threadId: "client-turn-1",
        turnId: "server-turn-1",
      }),
    ]);
  });
});
