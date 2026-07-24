import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceViewProps } from "@/home/voice/voice-view";
import {
  getLearningSession,
  listLearningSessions,
} from "./learning-session-store";
import { storeWakeAudio } from "./wake-audio-handoff";
import { LearningPage } from "./learning-page";

const navigateMock = vi.hoisted(() => vi.fn());
const setTitleMock = vi.hoisted(() => vi.fn(async () => ({})));
const sessionApiMock = vi.hoisted(() => ({
  getMessages: vi.fn(async () => [] as unknown[]),
  listSessions: vi.fn(async () => [] as unknown[]),
}));
const voiceViewMock = vi.hoisted(() => ({
  props: null as VoiceViewProps | null,
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/api/sessions", () => ({
  deleteSession: vi.fn(async () => undefined),
  getMessages: sessionApiMock.getMessages,
  listSessions: sessionApiMock.listSessions,
  setSessionTitle: setTitleMock,
}));

vi.mock("@/runtime/runtime-provider", () => ({
  ScopedRuntimeBridge: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/runtime/session-context", () => ({
  SessionContext: {
    Provider: ({ children }: { children: ReactNode }) => children,
  },
  useModeState: () => ({ queueMode: null, adaptiveMode: null }),
}));

vi.mock("@/components/ui-protocol-question-host", () => ({
  UiProtocolQuestionHost: () => null,
}));

vi.mock("@/home/voice/audio-playback", () => ({
  unlockAudio: vi.fn(),
}));

vi.mock("@/settings/settings-api", () => ({
  getMyProfileSkills: vi.fn(async () => [
    {
      name: "learning-coach",
      source_repo: "alan0x/learning-coach",
      tool_count: 0,
      version: "0.4.0",
    },
  ]),
}));

vi.mock("@/home/voice/voice-view", () => ({
  VoiceView: (props: VoiceViewProps) => {
    voiceViewMock.props = props;
    return <div data-testid="learning-voice-view" />;
  },
}));

describe("LearningPage", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    localStorage.setItem("octos_learning_auto_camera", "true");
    navigateMock.mockReset();
    setTitleMock.mockClear();
    sessionApiMock.getMessages.mockReset();
    sessionApiMock.getMessages.mockResolvedValue([]);
    sessionApiMock.listSessions.mockReset();
    sessionApiMock.listSessions.mockResolvedValue([]);
    voiceViewMock.props = null;
  });

  it("hands wake audio to a hidden provisional learning session", async () => {
    const wake = new Blob(["wake"], { type: "audio/wav" });
    storeWakeAudio(wake);

    render(<LearningPage />);

    await waitFor(() => expect(voiceViewMock.props).not.toBeNull());
    expect(voiceViewMock.props?.sessionId).toMatch(/^learn-/);
    expect(voiceViewMock.props?.initialAudio).toBe(wake);
    expect(voiceViewMock.props?.conversationOptions?.autoStartCamera).toBe(true);
    expect(listLearningSessions()).toEqual([]);
    expect(
      voiceViewMock.props?.conversationOptions?.buildTurnText?.({
        sessionId: voiceViewMock.props.sessionId,
        turnId: "turn-1",
        mediaPaths: ["uploads/wake.wav"],
      }),
    ).toContain("entry: wake-word");
  });

  it("promotes and titles the session after substantive ASR", async () => {
    render(<LearningPage />);
    await waitFor(() => expect(voiceViewMock.props).not.toBeNull());
    const sessionId = voiceViewMock.props?.sessionId as string;

    await act(async () => {
      voiceViewMock.props?.onTurnsChange?.([
        {
          id: "turn-1",
          userText: "这道二次函数题我不会",
          assistantText: "",
          awaitingTranscript: false,
        },
      ]);
    });

    expect(listLearningSessions()).toEqual([
      expect.objectContaining({
        id: sessionId,
        status: "active",
        title: "这道二次函数题我不会",
      }),
    ]);
    expect(setTitleMock).toHaveBeenCalledWith(
      sessionId,
      "这道二次函数题我不会",
    );
  });

  it("rebuilds and resumes a server learning session when the local index is lost", async () => {
    sessionApiMock.listSessions.mockResolvedValue([
      {
        id: "learn-900-server",
        message_count: 4,
        title: "几何证明",
      },
    ]);
    sessionApiMock.getMessages.mockResolvedValue([
      {
        role: "user",
        content:
          "[[LEARNING_CONTEXT]]\nactive: true\nsession_id: learn-900-server\n[[/LEARNING_CONTEXT]]\n帮我继续几何证明",
        timestamp: "2026-07-24T12:00:00.000Z",
      },
    ]);

    render(<LearningPage />);

    await waitFor(() =>
      expect(voiceViewMock.props?.sessionId).toBe("learn-900-server"),
    );
    expect(listLearningSessions()).toEqual([
      expect.objectContaining({
        id: "learn-900-server",
        status: "active",
        title: "几何证明",
      }),
    ]);
  });

  it("completes the session after a spoken exit review", async () => {
    render(<LearningPage />);
    await waitFor(() => expect(voiceViewMock.props).not.toBeNull());
    const sessionId = voiceViewMock.props?.sessionId as string;
    await act(async () => {
      voiceViewMock.props?.onTurnsChange?.([
        {
          id: "turn-1",
          userText: "一起学习概率",
          assistantText: "好",
          awaitingTranscript: false,
        },
      ]);
    });
    await act(async () => {
      voiceViewMock.props?.onVoiceExit?.();
    });
    expect(getLearningSession(sessionId)?.status).toBe("completed");
    expect(navigateMock).toHaveBeenCalledWith("/");
  });
});
