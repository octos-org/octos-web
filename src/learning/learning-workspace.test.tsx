import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceConversation } from "@/home/voice/use-voice-conversation";
import { LearningWorkspace } from "./learning-workspace";

const conversationMock = vi.hoisted(() => ({
  turns: [] as VoiceConversation["turns"],
}));

vi.mock("@/api/chat", () => ({ uploadFiles: vi.fn() }));
vi.mock("@/runtime/ui-protocol-send", () => ({ sendMessage: vi.fn() }));
vi.mock("@/home/voice/audio-playback", () => ({ unlockAudio: vi.fn() }));
vi.mock("@/store/projection-render-adapter", () => ({
  useRenderThreads: () => [],
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
});
