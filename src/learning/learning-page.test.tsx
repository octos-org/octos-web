import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningWorkspaceProps } from "./learning-workspace";
import {
  createProvisionalLearningSession,
  getLearningSession,
  listLearningSessions,
  promoteLearningSession,
} from "./learning-session-store";
import { storeWakeAudio } from "./wake-audio-handoff";
import { LearningPage } from "./learning-page";

const navigateMock = vi.hoisted(() => vi.fn());
const setTitleMock = vi.hoisted(() => vi.fn(async () => ({})));
const deleteSessionMock = vi.hoisted(() => vi.fn(async () => undefined));
const sessionApiMock = vi.hoisted(() => ({
  listSessions: vi.fn(async () => [] as unknown[]),
  getSessionFiles: vi.fn(async (sessionId: string) => [
    {
      filename: "turn-1.octos-lesson.json",
      path: `sessions/${sessionId}/turn-1.octos-lesson.json`,
      size_bytes: 1,
      modified_at: "2026-07-29T00:00:00Z",
    },
  ]),
}));
const learningWorkspaceMock = vi.hoisted(() => ({
  props: null as LearningWorkspaceProps | null,
}));
const profileSkillsMock = vi.hoisted(() => ({
  skills: [
    {
      name: "learning-coach",
      source_repo: "alan0x/learning-coach",
      tool_count: 0,
      version: "0.8.4",
    },
  ],
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/api/sessions", () => ({
  deleteSession: deleteSessionMock,
  getSessionFiles: sessionApiMock.getSessionFiles,
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
  getMyProfileSkills: vi.fn(async () => profileSkillsMock.skills),
}));

vi.mock("./learning-workspace", () => ({
  LearningWorkspace: (props: LearningWorkspaceProps) => {
    learningWorkspaceMock.props = props;
    return <div data-testid="learning-workspace" />;
  },
}));

describe("LearningPage", () => {
  beforeEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/learn");
    localStorage.clear();
    localStorage.setItem("octos_learning_auto_camera", "true");
    navigateMock.mockReset();
    setTitleMock.mockClear();
    deleteSessionMock.mockClear();
    sessionApiMock.listSessions.mockReset();
    sessionApiMock.listSessions.mockResolvedValue([]);
    sessionApiMock.getSessionFiles.mockReset();
    sessionApiMock.getSessionFiles.mockImplementation(async (sessionId) => [
      {
        filename: "turn-1.octos-lesson.json",
        path: `sessions/${sessionId}/turn-1.octos-lesson.json`,
        size_bytes: 1,
        modified_at: "2026-07-29T00:00:00Z",
      },
    ]);
    learningWorkspaceMock.props = null;
    profileSkillsMock.skills = [
      {
        name: "learning-coach",
        source_repo: "alan0x/learning-coach",
        tool_count: 0,
        version: "0.8.4",
      },
    ];
  });

  it("opens the opt-in OLL fixture without Skill or device gates", async () => {
    window.history.replaceState(
      {},
      "",
      "/learn?oll-fixture=geometry-v2",
    );
    profileSkillsMock.skills = [];
    localStorage.clear();

    render(<LearningPage />);

    await waitFor(() => expect(learningWorkspaceMock.props).not.toBeNull());
    expect(learningWorkspaceMock.props?.ollFixture).toBe("geometry-v2");
    expect(learningWorkspaceMock.props?.voiceEnabled).toBe(false);
    expect(
      screen.queryByRole("heading", { name: /learning-coach/ }),
    ).toBeNull();
  });

  it("blocks an installed learning coach that predates request-source isolation", async () => {
    profileSkillsMock.skills[0].version = "0.8.3";

    render(<LearningPage />);

    expect(
      await screen.findByRole("heading", {
        name: "learning-coach 版本过旧",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/需要 learning-coach 0.8.4/)).toBeTruthy();
    expect(learningWorkspaceMock.props).toBeNull();
  });

  it("hands wake audio to a hidden provisional learning session", async () => {
    const wake = new Blob(["wake"], { type: "audio/wav" });
    storeWakeAudio(wake);

    render(<LearningPage />);

    await waitFor(() => expect(learningWorkspaceMock.props).not.toBeNull());
    expect(learningWorkspaceMock.props?.sessionId).toMatch(/^learn-/);
    expect(learningWorkspaceMock.props?.initialAudio).toBe(wake);
    expect(
      learningWorkspaceMock.props?.conversationOptions?.autoStartCamera,
    ).toBe(true);
    expect(
      learningWorkspaceMock.props?.conversationOptions?.playReplyAudio,
    ).toBe(false);
    expect(listLearningSessions()).toEqual([]);
    expect(
      learningWorkspaceMock.props?.conversationOptions?.buildTurnText?.({
        sessionId: learningWorkspaceMock.props.sessionId,
        turnId: "turn-1",
        mediaPaths: ["uploads/wake.wav"],
      }),
    ).toContain("entry: wake-word");
  });

  it("enters the whiteboard in text-only mode without requesting devices", async () => {
    localStorage.clear();

    render(<LearningPage />);

    const textOnly = await screen.findByRole("button", {
      name: "仅用文字进入白板",
    });
    fireEvent.click(textOnly);

    await waitFor(() =>
      expect(learningWorkspaceMock.props?.voiceEnabled).toBe(false),
    );
    expect(localStorage.getItem("octos_learning_input_mode")).toBe("text");

    const sessionId = learningWorkspaceMock.props?.sessionId as string;
    await act(async () => {
      learningWorkspaceMock.props?.onLearnerInput?.(
        "请在白板上讲解一个新的二次函数问题",
      );
    });
    expect(getLearningSession(sessionId)?.status).toBe("active");
    fireEvent.click(
      screen.getByRole("button", { name: "打开学习会话列表" }),
    );
    expect(
      screen.getByRole("button", {
        name: "请在白板上讲解一个新的二次函数问题",
      }),
    ).toBeTruthy();
  });

  it("can enable voice and camera from an existing text-only lesson", async () => {
    localStorage.setItem("octos_learning_auto_camera", "false");
    localStorage.setItem("octos_learning_input_mode", "text");
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: stopTrack }],
    }));
    const originalMediaDevices = Object.getOwnPropertyDescriptor(
      navigator,
      "mediaDevices",
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    try {
      render(<LearningPage />);
      await waitFor(() =>
        expect(learningWorkspaceMock.props?.voiceEnabled).toBe(false),
      );
      await act(async () => {
        await learningWorkspaceMock.props?.onUseVoiceMode?.();
      });

      await waitFor(() =>
        expect(learningWorkspaceMock.props?.voiceEnabled).toBe(true),
      );
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: true,
        video: true,
      });
      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem("octos_learning_input_mode")).toBe("voice");
      expect(localStorage.getItem("octos_learning_auto_camera")).toBe("true");
    } finally {
      if (originalMediaDevices) {
        Object.defineProperty(
          navigator,
          "mediaDevices",
          originalMediaDevices,
        );
      } else {
        Reflect.deleteProperty(navigator, "mediaDevices");
      }
    }
  });

  it("does not time out or delete an idle provisional whiteboard", async () => {
    vi.useFakeTimers();
    try {
      render(<LearningPage />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const provisional = listLearningSessions({
        includeProvisional: true,
      })[0];
      expect(provisional?.status).toBe("provisional");

      act(() => {
        vi.advanceTimersByTime(30 * 60 * 1000);
      });

      expect(navigateMock).not.toHaveBeenCalled();
      expect(deleteSessionMock).not.toHaveBeenCalledWith(provisional.id);
      expect(getLearningSession(provisional.id)?.status).toBe("provisional");
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries the existing board summary into a follow-up turn", async () => {
    render(<LearningPage />);
    await waitFor(() => expect(learningWorkspaceMock.props).not.toBeNull());

    act(() => {
      learningWorkspaceMock.props?.onBoardContextChange?.({
        lastAppliedAction: "turn-1-formula-2",
        boardSummary: "y=x^2+6x+5；y=(x+3)^2-4；顶点(-3,-4)",
      });
    });

    const context =
      learningWorkspaceMock.props?.conversationOptions?.buildTurnText?.({
        sessionId: learningWorkspaceMock.props.sessionId,
        turnId: "turn-2",
        mediaPaths: [],
      }) ?? "";
    expect(context).toContain("last_applied_action: turn-1-formula-2");
    expect(context).toContain(
      "board_summary: y=x^2+6x+5；y=(x+3)^2-4；顶点(-3,-4)",
    );
    expect(context).not.toContain("pending_goal");
  });

  it("promotes and titles the session after substantive ASR", async () => {
    render(<LearningPage />);
    await waitFor(() => expect(learningWorkspaceMock.props).not.toBeNull());
    const sessionId = learningWorkspaceMock.props?.sessionId as string;

    await act(async () => {
      learningWorkspaceMock.props?.onTurnsChange?.([
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
    render(<LearningPage />);

    await waitFor(() =>
      expect(learningWorkspaceMock.props?.sessionId).toBe("learn-900-server"),
    );
    expect(listLearningSessions()).toEqual([
      expect.objectContaining({
        id: "learn-900-server",
        status: "active",
        title: "几何证明",
      }),
    ]);
  });

  it("switches between server-backed OLL sessions from the sidebar", async () => {
    sessionApiMock.listSessions.mockResolvedValue([
      { id: "learn-200-geometry", message_count: 4, title: "几何课程" },
      { id: "learn-100-algebra", message_count: 4, title: "代数课程" },
    ]);
    render(<LearningPage />);

    await waitFor(() =>
      expect(learningWorkspaceMock.props?.sessionId).toBe(
        "learn-200-geometry",
      ),
    );
    expect(learningWorkspaceMock.props?.playbackMode).toBe("review");
    fireEvent.click(
      screen.getByRole("button", { name: "打开学习会话列表" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "代数课程" }));

    await waitFor(() =>
      expect(learningWorkspaceMock.props?.sessionId).toBe(
        "learn-100-algebra",
      ),
    );
    expect(learningWorkspaceMock.props?.playbackMode).toBe("review");

    act(() => {
      learningWorkspaceMock.props?.onLearnerInput?.("继续讲一道相似题");
    });
    await waitFor(() =>
      expect(learningWorkspaceMock.props?.playbackMode).toBe("live"),
    );
  });

  it("does not expose a transcript-only learning session without an OLL lesson", async () => {
    sessionApiMock.listSessions.mockResolvedValue([
      { id: "learn-903-no-lesson", message_count: 2, title: "失败课程" },
    ]);
    sessionApiMock.getSessionFiles.mockResolvedValue([]);

    render(<LearningPage />);

    await waitFor(() => expect(learningWorkspaceMock.props).not.toBeNull());
    expect(learningWorkspaceMock.props?.sessionId).not.toBe(
      "learn-903-no-lesson",
    );
    expect(getLearningSession("learn-903-no-lesson")).toBeNull();
  });

  it("repairs a provisional local session from its durable server transcript", async () => {
    const { id: sessionId } = createProvisionalLearningSession(900);
    sessionApiMock.listSessions.mockResolvedValue([
      { id: sessionId, message_count: 2, title: "负数乘法" },
    ]);
    render(<LearningPage />);

    await waitFor(() =>
      expect(getLearningSession(sessionId)).toEqual(
        expect.objectContaining({
          status: "active",
          title: "负数乘法",
        }),
      ),
    );
    expect(deleteSessionMock).not.toHaveBeenCalledWith(sessionId);
  });

  it("preserves a local session title while reconciling its server transcript", async () => {
    const { id: sessionId } = createProvisionalLearningSession(901);
    promoteLearningSession(sessionId, "已保存课程", 902);
    sessionApiMock.listSessions.mockResolvedValue([
      { id: sessionId, message_count: 2, title: "[[LEARNING_SESSION]]" },
    ]);

    render(<LearningPage />);

    await waitFor(() => expect(learningWorkspaceMock.props).not.toBeNull());
    expect(getLearningSession(sessionId)).toEqual(
      expect.objectContaining({ title: "已保存课程" }),
    );
    expect(deleteSessionMock).not.toHaveBeenCalledWith(sessionId);
  });

  it("does not expose a confirmed empty server shell as a learning session", async () => {
    sessionApiMock.listSessions.mockResolvedValue([
      { id: "learn-902-empty", message_count: 0, title: null },
    ]);
    sessionApiMock.getSessionFiles.mockResolvedValue([]);

    render(<LearningPage />);

    await waitFor(() => expect(learningWorkspaceMock.props).not.toBeNull());
    expect(getLearningSession("learn-902-empty")).toBeNull();
    expect(deleteSessionMock).not.toHaveBeenCalledWith("learn-902-empty");
  });

  it("drops a stale local index after an authoritative server list", async () => {
    const { id: staleId } = createProvisionalLearningSession(904);
    promoteLearningSession(staleId, "旧的本地会话", 905);
    sessionApiMock.listSessions.mockResolvedValue([]);

    render(<LearningPage />);

    await waitFor(() => expect(learningWorkspaceMock.props).not.toBeNull());
    expect(getLearningSession(staleId)).toBeNull();
    expect(learningWorkspaceMock.props?.sessionId).not.toBe(staleId);
  });

  it("completes the session after a spoken exit review", async () => {
    render(<LearningPage />);
    await waitFor(() => expect(learningWorkspaceMock.props).not.toBeNull());
    const sessionId = learningWorkspaceMock.props?.sessionId as string;
    await act(async () => {
      learningWorkspaceMock.props?.onTurnsChange?.([
        {
          id: "turn-1",
          userText: "一起学习概率",
          assistantText: "好",
          awaitingTranscript: false,
        },
      ]);
    });
    await act(async () => {
      learningWorkspaceMock.props?.onVoiceExit?.();
    });
    expect(getLearningSession(sessionId)?.status).toBe("completed");
    expect(navigateMock).toHaveBeenCalledWith("/");
  });
});
