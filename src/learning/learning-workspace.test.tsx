import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceConversation } from "@/home/voice/use-voice-conversation";
import type { Thread } from "@/store/thread-store";
import { LearningWorkspace } from "./learning-workspace";

const conversationMock = vi.hoisted(() => ({
  turns: [] as VoiceConversation["turns"],
  threads: [] as Thread[],
}));

vi.mock("@/api/chat", () => ({ uploadFiles: vi.fn() }));
vi.mock("@/runtime/ui-protocol-send", () => ({ sendMessage: vi.fn() }));
vi.mock("@/home/voice/audio-playback", () => ({ unlockAudio: vi.fn() }));
vi.mock("@/store/projection-render-adapter", () => ({
  useRenderThreads: () => conversationMock.threads,
}));
vi.mock("@/home/use-ominix-runtime-summary", () => ({
  useOminixRuntimeSummary: () => ({
    ready: true,
    loading: false,
  }),
}));
vi.mock("@/home/voice/use-voice-conversation", () => ({
  useVoiceConversation: () => ({
    state: "idle",
    lastUserText: "",
    lastAssistantText: conversationMock.turns.at(-1)?.assistantText ?? "",
    turns: conversationMock.turns,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    interrupt: vi.fn(),
    cameraActive: false,
    cameraStream: null,
    lastSentFrameUrl: null,
    cameraError: null,
    toggleCamera: vi.fn(),
    generating: false,
    exiting: false,
    visual: null,
    dismissVisual: vi.fn(),
  }),
}));

describe("LearningWorkspace", () => {
  beforeEach(() => {
    cleanup();
    conversationMock.turns = [];
    conversationMock.threads = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("puts an ordinary assistant explanation on the board and keeps the teacher caption brief", () => {
    const longReply =
      "第一步：先看 $x^2 + 6x$。配方公式是 $(x+b)^2=x^2+2bx+b^2$。\n\n所以得到 $y=(x+3)^2-4$。";
    conversationMock.turns = [
      {
        id: "turn-1",
        userText: "把 y = x² + 6x + 5 配方，并说出顶点。",
        assistantText: longReply,
        awaitingTranscript: false,
      },
    ];

    render(
      <LearningWorkspace
        sessionId="learn-test"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText("题目")).toBeTruthy();
    expect(
      screen.getAllByText(/把 y = x² \+ 6x \+ 5 配方/).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("我先把题目写在白板上。")).toBeTruthy();
    expect(screen.queryByText(longReply)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByLabelText("x^2 + 6x")).toBeTruthy();
  });

  it("feeds the OLL fixture into the real /learn Runtime as incremental events", () => {
    vi.useFakeTimers();
    render(
      <LearningWorkspace
        sessionId="learn-stream-test"
        voiceEnabled={false}
        ollFixture="geometry-v2"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText(/OLL · Beat 0\/0/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(260));
    expect(screen.queryByText(/OLL · Beat 0\/0/)).toBeNull();
    expect(screen.getByText(/OLL · Beat \d+\/\d+/)).toBeTruthy();
  });

  it("loads a delivered OLL Authoring artifact into the /learn Runtime", async () => {
    conversationMock.threads = [{
      id: "client-turn",
      turnId: "server-turn",
      userMsg: {
        id: "user",
        role: "user",
        text: "讲解",
        files: [],
        toolCalls: [],
        status: "complete",
        timestamp: 1,
      },
      responses: [{
        id: "assistant",
        role: "assistant",
        text: "我们开始。",
        files: [{
          filename: "server-turn.octos-lesson.json",
          path: "study/oll/server-turn.octos-lesson.json",
        }],
        toolCalls: [],
        status: "complete",
        timestamp: 2,
      }],
      pendingAssistant: null,
    }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        dsl: "octos.lesson",
        version: "0.1",
        profile: "authoring",
        lesson: {
          mode: "explain",
          language: "zh-CN",
          title: "模型生成的 OLL 课程",
          goals: ["解释概念"],
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
      }),
    }));

    render(
      <LearningWorkspace
        sessionId="learn-model-test"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("模型生成的 OLL 课程")).toBeTruthy();
      expect(screen.getByTestId("oll-controls")).toBeTruthy();
    });
  });
});
