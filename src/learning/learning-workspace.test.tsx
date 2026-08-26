import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INK_SELECTION_FORMAT,
  INK_SELECTION_FORMAT_VERSION,
  inkSvgChecksum,
  type InkSelectionSnapshot,
} from "octos-lesson-language/ink-runtime";
import type {
  VoiceConversation,
  VoiceConversationOptions,
} from "@/home/voice/use-voice-conversation";
import type { Thread } from "@/store/thread-store";
import {
  buildDegradedVisualRetryContext,
  buildDegradedVisualRetryPrompt,
} from "./degraded-visual-retry";
import { LearningWorkspace } from "./learning-workspace";
import { saveSelectionEnhancementState } from "./selection-enhancements";
import { saveWhiteboardQuestions } from "./whiteboard-questions";

const conversationMock = vi.hoisted(() => ({
  turns: [] as VoiceConversation["turns"],
  threads: [] as Thread[],
  start: vi.fn(async () => undefined),
  stop: vi.fn(),
  startCamera: vi.fn(async () => true),
  stopCamera: vi.fn(),
  toggleCamera: vi.fn(),
  cameraActive: false,
  cameraStream: null as MediaStream | null,
  lastSentFrameUrl: null as string | null,
  cameraSettings: {
    rotation: 0 as const,
    mirror: false,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    documentMode: true,
  },
  updateCameraSettings: vi.fn(),
  resetCameraSettings: vi.fn(),
  options: null as VoiceConversationOptions | null,
  optionsHistory: [] as VoiceConversationOptions[],
}));
const sessionFilesMock = vi.hoisted(() => ({
  getSessionFiles: vi.fn(async () => []),
  invokeSkillAction: vi.fn(async () => ({ action_id: "learning.selection.enhance", ok: true, results: [] })),
  listSkillActionJobs: vi.fn(async () => []),
}));
const sendMessageMock = vi.hoisted(() => vi.fn());
const narrationTtsMock = vi.hoisted(() => ({
  useOllNarrationTts: vi.fn(() => ({ error: null, preparing: false })),
}));
const inkRuntimeMock = vi.hoisted(() => ({
  mountInkRuntime: vi.fn(),
}));

vi.mock("@/api/chat", () => ({ uploadFiles: vi.fn() }));
vi.mock("@/api/sessions", () => ({
  getSessionFiles: sessionFilesMock.getSessionFiles,
}));
vi.mock("@/api/skill-actions", () => ({
  invokeSkillAction: sessionFilesMock.invokeSkillAction,
  listSkillActionJobs: sessionFilesMock.listSkillActionJobs,
}));
vi.mock("@/runtime/ui-protocol-send", () => ({ sendMessage: sendMessageMock }));
vi.mock("@/home/voice/audio-playback", () => ({ unlockAudio: vi.fn() }));
vi.mock("@/home/voice/camera-preview", () => ({
  CameraPreview: () => <canvas data-testid="camera-preview" />,
}));
vi.mock("./oll/use-oll-narration-tts", () => ({
  useOllNarrationTts: narrationTtsMock.useOllNarrationTts,
}));
vi.mock("./oll/oll-ink-runtime", () => ({
  mountInkRuntime: inkRuntimeMock.mountInkRuntime,
}));
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
  useVoiceConversation: (
    _sessionId: string,
    _historyTopic: string | undefined,
    _onExit: (() => void) | undefined,
    options: VoiceConversationOptions,
  ) => {
    conversationMock.options = options;
    conversationMock.optionsHistory.push(options);
    return {
    state: "idle",
    lastUserText: "",
    lastAssistantText: conversationMock.turns.at(-1)?.assistantText ?? "",
    turns: conversationMock.turns,
    error: null,
    start: conversationMock.start,
    stop: conversationMock.stop,
    interrupt: vi.fn(),
    cameraActive: conversationMock.cameraActive,
    cameraStream: conversationMock.cameraStream,
    lastSentFrameUrl: conversationMock.lastSentFrameUrl,
    cameraError: null,
    cameraSettings: conversationMock.cameraSettings,
    updateCameraSettings: conversationMock.updateCameraSettings,
    resetCameraSettings: conversationMock.resetCameraSettings,
    startCamera: conversationMock.startCamera,
    stopCamera: conversationMock.stopCamera,
    toggleCamera: conversationMock.toggleCamera,
    generating: false,
    exiting: false,
    visual: null,
    dismissVisual: vi.fn(),
    };
  },
}));

describe("LearningWorkspace", () => {
  it("builds a component-only retry request that preserves the existing board", () => {
    const degraded = {
      boardId: "learning-board-session-1",
      boardRevision: 12,
      nodeId: "lesson:node:paraboloid-scene",
      visualId: "paraboloid-scene",
      surface: "scene3d",
      purpose: "展示可旋转的抛物面与水平截面",
      title: "这个互动画面暂时没有生成成功",
    };
    expect(buildDegradedVisualRetryPrompt(degraded)).toBe(
      "请重新生成没有成功展示的三维场景“展示可旋转的抛物面与水平截面”。只补充这个画面，不要重做整堂课。",
    );
    const context = buildDegradedVisualRetryContext(degraded);
    expect(context).toContain("request_source: explicit_board_follow_up");
    expect(context).toContain("board_id: learning-board-session-1");
    expect(context).toContain("board_revision: 12");
    expect(context).toContain('"target_id":"lesson:node:paraboloid-scene"');
    expect(context).toContain('"as":"failed-visual"');
  });

  beforeEach(() => {
    cleanup();
    conversationMock.turns = [];
    conversationMock.threads = [];
    conversationMock.start.mockClear();
    conversationMock.stop.mockClear();
    conversationMock.startCamera.mockClear();
    conversationMock.stopCamera.mockClear();
    conversationMock.toggleCamera.mockClear();
    conversationMock.cameraActive = false;
    conversationMock.cameraStream = null;
    conversationMock.lastSentFrameUrl = null;
    conversationMock.cameraSettings = {
      rotation: 0,
      mirror: false,
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      documentMode: true,
    };
    conversationMock.updateCameraSettings.mockClear();
    conversationMock.resetCameraSettings.mockClear();
    conversationMock.options = null;
    conversationMock.optionsHistory = [];
    narrationTtsMock.useOllNarrationTts.mockClear();
    narrationTtsMock.useOllNarrationTts.mockReturnValue({
      error: null,
      preparing: false,
    });
    inkRuntimeMock.mountInkRuntime.mockReset();
    inkRuntimeMock.mountInkRuntime.mockImplementation(() => {
      const state = {
        mode: "navigate" as const,
        component_count: 0,
        selected_count: 0,
        pen_color: "#176b62",
        selection_color: null,
        selection_input: "unknown" as const,
        selection_mode: "rectangle" as const,
        selection_revision: 0,
        document_version: 0,
        saved: true,
      };
      return {
        ready: Promise.resolve(),
        state,
        subscribe: vi.fn((listener: (next: typeof state) => void) => {
          listener(state);
          return () => undefined;
        }),
        setMode: vi.fn(),
        setPenColor: vi.fn(),
        setSelectionColor: vi.fn(),
        setSelectionMode: vi.fn(),
        selectAll: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        mergeSavedDocument: vi.fn(async () => null),
        destroy: vi.fn(async () => undefined),
      };
    });
    sessionFilesMock.getSessionFiles.mockReset();
    sessionFilesMock.getSessionFiles.mockResolvedValue([]);
    sessionFilesMock.invokeSkillAction.mockReset();
    sessionFilesMock.invokeSkillAction.mockResolvedValue({
      action_id: "learning.selection.enhance",
      ok: true,
      results: [],
    });
    sessionFilesMock.listSkillActionJobs.mockReset();
    sessionFilesMock.listSkillActionJobs.mockResolvedValue([]);
    sendMessageMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the live camera and the exact frame sent with the voice turn", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    conversationMock.cameraActive = true;
    conversationMock.cameraStream = {
      getTracks: () => [],
    } as unknown as MediaStream;
    conversationMock.lastSentFrameUrl = "blob:sent-frame";

    render(
      <LearningWorkspace
        sessionId="learn-camera-feedback"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByTestId("camera-preview")).toBeTruthy();
    expect(screen.getByText("老师看到的画面")).toBeTruthy();
    expect(
      screen.getByAltText("本轮已发送给老师的画面").getAttribute("src"),
    ).toBe("blob:sent-frame");
    expect(screen.getByText("本轮已发送")).toBeTruthy();
  });

  it("lets the learner calibrate the exact camera frame sent to the teacher", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    conversationMock.cameraActive = true;
    conversationMock.cameraStream = {
      getTracks: () => [],
    } as unknown as MediaStream;

    render(
      <LearningWorkspace
        sessionId="learn-camera-calibration"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: "调整摄像头画面" }).click();
    });
    screen.getByRole("button", { name: "向右旋转摄像头画面" }).click();
    expect(conversationMock.updateCameraSettings).toHaveBeenCalledWith({
      rotation: 90,
    });
    expect(
      screen.getByRole("button", { name: /试卷清晰模式/ }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("lets text mode enable voice without also enabling the camera", async () => {
    const onUseVoiceMode = vi.fn(async () => undefined);
    render(
      <LearningWorkspace
        sessionId="learn-enable-voice"
        voiceEnabled={false}
        onUseVoiceMode={onUseVoiceMode}
        onBack={vi.fn()}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: "启用语音" }).click();
      await Promise.resolve();
    });
    expect(onUseVoiceMode).toHaveBeenCalledTimes(1);
    expect(conversationMock.toggleCamera).not.toHaveBeenCalled();
  });

  it("keeps the camera independent in text mode and opens settings from its preview", async () => {
    const view = render(
      <LearningWorkspace
        sessionId="learn-camera-settings-in-text-mode"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "调整摄像头画面" })).toBeNull();
    screen.getByRole("button", { name: "启用摄像头" }).click();
    expect(conversationMock.toggleCamera).toHaveBeenCalledTimes(1);

    conversationMock.cameraActive = true;
    conversationMock.cameraStream = {
      getTracks: () => [],
    } as unknown as MediaStream;
    view.rerender(
      <LearningWorkspace
        sessionId="learn-camera-settings-in-text-mode"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    await act(async () => {
      screen.getByRole("button", { name: "调整摄像头画面" }).click();
      await Promise.resolve();
    });

    expect(conversationMock.startCamera).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "调整老师看到的画面" })).toBeTruthy();
    screen.getByRole("button", { name: "关闭摄像头画面设置" }).click();
    expect(conversationMock.stopCamera).not.toHaveBeenCalled();
  });

  it("releases microphone capture when switching from voice to text mode", () => {
    const { rerender } = render(
      <LearningWorkspace
        sessionId="learn-switch-to-text"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );
    expect(conversationMock.start).toHaveBeenCalledTimes(1);

    rerender(
      <LearningWorkspace
        sessionId="learn-switch-to-text"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    expect(conversationMock.stop).toHaveBeenCalledWith({
      preserveCamera: true,
    });
  });

  it("does not project ordinary assistant prose onto the OLL whiteboard", () => {
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

    expect(screen.getByText("向 Octos 提问，我们从这里开始")).toBeTruthy();
    expect(screen.queryByText(longReply)).toBeNull();
    expect(screen.queryByRole("button", { name: "下一步" })).toBeNull();
  });

  it("provides the shared handwriting toolbar on a new blank whiteboard", async () => {
    render(
      <LearningWorkspace
        sessionId="learn-blank-whiteboard-ink"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(inkRuntimeMock.mountInkRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          storageKey: "octos-learning-ink:v1:learn-blank-whiteboard-ink",
          documentId:
            "learning-session:learn-blank-whiteboard-ink:student-ink",
        }),
      );
      expect(screen.getByLabelText("白板书写工具")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "书写笔迹" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "擦除笔迹" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "框选多个笔迹" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "自由圈选笔迹" })).toBeNull();
  });

  it("speaks a completed plain reply without covering the board with a notice", async () => {
    vi.useFakeTimers();
    conversationMock.turns = [{
      id: "camera-clarification",
      userText: "这道题怎么写",
      assistantText: "画面有些模糊，请把试卷转正并移近一点。",
      awaitingTranscript: false,
    }];
    const view = render(
      <LearningWorkspace
        sessionId="learn-camera-clarification"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    act(() => {
      conversationMock.options?.onTurnComplete?.("camera-clarification");
      view.rerender(
        <LearningWorkspace
          sessionId="learn-camera-clarification"
          voiceEnabled
          onBack={vi.fn()}
        />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(2_600);
    });

    expect(narrationTtsMock.useOllNarrationTts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        playing: true,
        text: "画面有些模糊，请把试卷转正并移近一点。",
        narrationId: "plain-reply:camera-clarification",
      }),
    );
    expect(screen.queryByText(/本轮没有更新白板/)).toBeNull();
  });

  it("places lesson generation feedback on the whiteboard", async () => {
    render(
      <LearningWorkspace
        sessionId="learn-loading-lesson"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("输入学习问题"), {
      target: { value: "请解释勾股定理" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    expect(await screen.findByLabelText(
      /正在搭建这节课。先整理重点，再把讲解和互动画面放到白板上/,
    )).toBeTruthy();
    expect(screen.getByText("我的问题")).toBeTruthy();
    expect(screen.getByText("请解释勾股定理")).toBeTruthy();
    expect(localStorage.getItem(
      "octos-learning-questions:v1:learn-loading-lesson",
    )).toContain("请解释勾股定理");
    await waitFor(() => expect(localStorage.getItem(
      "octos-learning-course-regions:v1:learn-loading-lesson",
    )).toContain("learn-loading-lesson"));
    expect(screen.queryByText(/白板暂未更新/)).toBeNull();
  });

  it("routes an admitted voice lesson directly to the background lesson action", async () => {
    sessionFilesMock.invokeSkillAction.mockResolvedValueOnce({
      action_id: "learning.lesson.generate",
      ok: true,
      queued: 1,
      jobs: [{
        job_id: "voice-lesson-job",
        batch_id: "voice-lesson-batch",
        profile_id: "alan0x",
        session_id: "learn-voice-question",
        action_id: "learning.lesson.generate",
        skill_id: "learning-coach",
        status: "queued",
        created_at: "2026-08-22T00:00:00Z",
        updated_at: "2026-08-22T00:00:00Z",
      }],
    });
    render(
      <LearningWorkspace
        sessionId="learn-voice-question"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    act(() => {
      conversationMock.options?.onTurnStart?.("voice-lesson-turn");
    });
    expect(screen.queryByText("我的问题")).toBeNull();

    await act(async () => {
      const handled = await conversationMock.options?.onAdmittedSpeech?.({
        sessionId: "learn-voice-question",
        turnId: "voice-lesson-turn",
        transcript: "自然对数的意义是怎么推导的？",
        admissionId: "voice-admission-1",
        mediaPaths: ["uploads/utterance.wav"],
        additionalMediaPaths: [],
      });
      expect(handled).toBe(true);
    });

    expect(await screen.findByText("自然对数的意义是怎么推导的？"))
      .toBeTruthy();
    expect(sessionFilesMock.invokeSkillAction).toHaveBeenCalledWith(
      "learn-voice-question",
      "learning.lesson.generate",
      expect.objectContaining({
        turn_id: "voice-lesson-turn",
        learner_request: "自然对数的意义是怎么推导的？",
        request_source: "self_contained",
        input_modality: "voice",
      }),
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    await waitFor(() => expect(localStorage.getItem(
      "octos-learning-course-regions:v1:learn-voice-question",
    )).toContain("voice-lesson-turn"));

    act(() => {
      window.dispatchEvent(new CustomEvent("crew:skill_action_job_updated", {
        detail: {
          job_id: "voice-lesson-job",
          batch_id: "voice-lesson-batch",
          profile_id: "alan0x",
          session_id: "learn-voice-question",
          action_id: "learning.lesson.generate",
          skill_id: "learning-coach",
          status: "succeeded",
          created_at: "2026-08-22T00:00:00Z",
          updated_at: "2026-08-22T00:00:05Z",
        },
      }));
    });
    expect(await screen.findByText("已回答")).toBeTruthy();
  });

  it("shows a clarification instead of a guessed lesson for ambiguous admitted speech", async () => {
    sessionFilesMock.invokeSkillAction.mockResolvedValueOnce({
      action_id: "learning.lesson.generate",
      ok: true,
      queued: 1,
      jobs: [{
        job_id: "voice-clarify-job",
        batch_id: "voice-clarify-batch",
        profile_id: "alan0x",
        session_id: "learn-voice-clarify",
        action_id: "learning.lesson.generate",
        skill_id: "learning-coach",
        status: "queued",
        created_at: "2026-08-23T00:00:00Z",
        updated_at: "2026-08-23T00:00:00Z",
      }],
    });
    render(
      <LearningWorkspace
        sessionId="learn-voice-clarify"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    await act(async () => {
      const handled = await conversationMock.options?.onAdmittedSpeech?.({
        sessionId: "learn-voice-clarify",
        turnId: "voice-clarify-turn",
        transcript: "The book.",
        admissionId: "voice-clarify-admission",
        mediaPaths: ["uploads/utterance.wav"],
        additionalMediaPaths: [],
      });
      expect(handled).toBe(true);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("crew:skill_action_job_updated", {
        detail: {
          job_id: "voice-clarify-job",
          batch_id: "voice-clarify-batch",
          profile_id: "alan0x",
          session_id: "learn-voice-clarify",
          action_id: "learning.lesson.generate",
          skill_id: "learning-coach",
          status: "succeeded",
          result: {
            success: true,
            output: "你想了解这本书的哪一方面？",
            structured_metadata: {
              lesson_disposition: "clarify",
              learner_response: "你想了解这本书的哪一方面？",
            },
          },
          created_at: "2026-08-23T00:00:00Z",
          updated_at: "2026-08-23T00:00:02Z",
        },
      }));
    });

    expect(await screen.findByText("你想了解这本书的哪一方面？"))
      .toBeTruthy();
    expect(await screen.findByText("已回答")).toBeTruthy();
    expect(screen.queryByLabelText(
      /正在搭建这节课。先整理重点，再把讲解和互动画面放到白板上/,
    )).toBeNull();
    expect(narrationTtsMock.useOllNarrationTts).toHaveBeenCalledWith(
      expect.objectContaining({
        playing: true,
        text: "你想了解这本书的哪一方面？",
      }),
    );
  });

  it("drops a filler voice turn when the lesson planner returns ignore", async () => {
    sessionFilesMock.invokeSkillAction.mockResolvedValueOnce({
      action_id: "learning.lesson.generate",
      ok: true,
      queued: 1,
      jobs: [{
        job_id: "voice-ignore-job",
        batch_id: "voice-ignore-batch",
        profile_id: "alan0x",
        session_id: "learn-voice-ignore",
        action_id: "learning.lesson.generate",
        skill_id: "learning-coach",
        status: "queued",
        created_at: "2026-08-23T00:00:00Z",
        updated_at: "2026-08-23T00:00:00Z",
      }],
    });
    render(
      <LearningWorkspace
        sessionId="learn-voice-ignore"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    await act(async () => {
      await conversationMock.options?.onAdmittedSpeech?.({
        sessionId: "learn-voice-ignore",
        turnId: "voice-ignore-turn",
        transcript: "嗯。",
        admissionId: "voice-ignore-admission",
        mediaPaths: ["uploads/utterance.wav"],
        additionalMediaPaths: [],
      });
    });
    expect(await screen.findByText("嗯。")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent("crew:skill_action_job_updated", {
        detail: {
          job_id: "voice-ignore-job",
          batch_id: "voice-ignore-batch",
          profile_id: "alan0x",
          session_id: "learn-voice-ignore",
          action_id: "learning.lesson.generate",
          skill_id: "learning-coach",
          status: "succeeded",
          result: {
            success: true,
            output: "",
            structured_metadata: {
              lesson_disposition: "ignore",
              learner_response: "",
            },
          },
          created_at: "2026-08-23T00:00:00Z",
          updated_at: "2026-08-23T00:00:02Z",
        },
      }));
    });

    await waitFor(() => expect(screen.queryByText("嗯。")).toBeNull());
    expect(screen.queryByLabelText(
      /正在搭建这节课。先整理重点，再把讲解和互动画面放到白板上/,
    )).toBeNull();
  });

  it("keeps camera and selection voice requests on the context-aware path", async () => {
    render(
      <LearningWorkspace
        sessionId="learn-context-voice"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    const cameraHandled = await conversationMock.options?.onAdmittedSpeech?.({
      sessionId: "learn-context-voice",
      turnId: "camera-turn",
      transcript: "请讲解镜头里的题目",
      admissionId: "camera-admission",
      mediaPaths: ["uploads/utterance.wav", "uploads/frame.jpg"],
      currentFramePath: "uploads/frame.jpg",
      additionalMediaPaths: [],
    });
    const selectionHandled = await conversationMock.options?.onAdmittedSpeech?.({
      sessionId: "learn-context-voice",
      turnId: "selection-turn",
      transcript: "解释我框选的部分",
      admissionId: "selection-admission",
      mediaPaths: ["uploads/utterance.wav", "uploads/selection.png"],
      additionalMediaPaths: ["uploads/selection.png"],
    });

    expect(cameraHandled).toBe(false);
    expect(selectionHandled).toBe(false);
    expect(sessionFilesMock.invokeSkillAction).not.toHaveBeenCalled();
  });

  it("clears the lesson loader and speaks a voice turn failure", async () => {
    render(
      <LearningWorkspace
        sessionId="learn-voice-error"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    act(() => {
      conversationMock.options?.onTurnStart?.("voice-error-turn");
    });
    await act(async () => {
      const handled = await conversationMock.options?.onAdmittedSpeech?.({
        sessionId: "learn-voice-error",
        turnId: "voice-error-turn",
        transcript: "请解释自然对数",
        admissionId: "voice-admission-error",
        mediaPaths: ["uploads/utterance.wav"],
        additionalMediaPaths: [],
      });
      expect(handled).toBe(true);
    });

    const failure = new Error("请求有点多，等几秒再试一次。");
    act(() => {
      conversationMock.options?.onTurnError?.("voice-error-turn", failure);
    });

    expect(screen.queryByLabelText(
      /正在搭建这节课。先整理重点，再把讲解和互动画面放到白板上/,
    )).toBeNull();
    expect(await screen.findByText("没有生成成功")).toBeTruthy();
    expect(narrationTtsMock.useOllNarrationTts).toHaveBeenCalledWith(
      expect.objectContaining({
        playing: true,
        text: "请求有点多，等几秒再试一次。",
      }),
    );
  });

  it("shows a separate loading block when another lesson is requested on a populated whiteboard", async () => {
    sessionFilesMock.invokeSkillAction.mockResolvedValueOnce({
      action_id: "learning.lesson.generate",
      ok: true,
      queued: 1,
      jobs: [{
        job_id: "lesson-job-follow-up",
        batch_id: "lesson-batch-follow-up",
        profile_id: "alan0x",
        session_id: "learn-follow-up-loading",
        action_id: "learning.lesson.generate",
        skill_id: "learning-coach",
        status: "queued",
        created_at: "2026-08-19T00:00:00Z",
        updated_at: "2026-08-19T00:00:00Z",
      }],
    });
    render(
      <LearningWorkspace
        sessionId="learn-follow-up-loading"
        voiceEnabled={false}
        onBack={vi.fn()}
        ollFixture="geometry-v2"
      />,
    );

    expect(await screen.findByText("连接 AD：一步一步看懂 SSS 全等")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("输入学习问题"), {
      target: { value: "请再讲一节二元函数课程" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    expect(await screen.findByLabelText(
      /正在搭建这节课。先整理重点，再把讲解和互动画面放到白板上/,
    )).toBeTruthy();
    expect(screen.getByText("请再讲一节二元函数课程")).toBeTruthy();
    const region = await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(
        "octos-learning-course-regions:v1:learn-follow-up-loading",
      ) ?? "[]") as Array<{ origin?: { x: number; y: number } }>;
      expect(saved).toHaveLength(1);
      expect(saved[0]?.origin).toBeTruthy();
      return saved[0]!;
    });
    const oldLessonRight = Math.max(...Array.from(
      document.querySelectorAll<HTMLElement>(".board-node"),
    ).map((node) => Number.parseFloat(node.style.left)
      + Number.parseFloat(node.style.width)));
    expect(region.origin!.x).toBeGreaterThanOrEqual(oldLessonRight + 180);
  });

  it("sends a composer lesson directly to the background lesson action", async () => {
    sessionFilesMock.invokeSkillAction.mockResolvedValueOnce({
      action_id: "learning.lesson.generate",
      ok: true,
      queued: 1,
      jobs: [{
        job_id: "lesson-job-1",
        batch_id: "lesson-batch-1",
        profile_id: "alan0x",
        session_id: "learn-direct-lesson",
        action_id: "learning.lesson.generate",
        skill_id: "learning-coach",
        status: "queued",
        created_at: "2026-08-19T00:00:00Z",
        updated_at: "2026-08-19T00:00:00Z",
      }],
    });
    render(
      <LearningWorkspace
        sessionId="learn-direct-lesson"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("输入学习问题"), {
      target: { value: "请解释勾股定理" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));

    await waitFor(() => expect(sessionFilesMock.invokeSkillAction).toHaveBeenCalledWith(
      "learn-direct-lesson",
      "learning.lesson.generate",
      expect.objectContaining({
        learner_request: "请解释勾股定理",
        request_source: "self_contained",
        language: "zh-CN",
        input_modality: "text",
      }),
    ));
    expect(sessionFilesMock.invokeSkillAction.mock.calls[0]?.[2]?.turn_id)
      .toEqual(expect.any(String));
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(
      "octos-learning-lesson-jobs:v1:learn-direct-lesson",
    )).toContain("lesson-job-1");

    act(() => {
      window.dispatchEvent(new CustomEvent("crew:skill_action_job_updated", {
        detail: {
          job_id: "lesson-job-1",
          batch_id: "lesson-batch-1",
          profile_id: "alan0x",
          session_id: "learn-direct-lesson",
          action_id: "learning.lesson.generate",
          skill_id: "learning-coach",
          status: "succeeded",
          created_at: "2026-08-19T00:00:00Z",
          updated_at: "2026-08-19T00:00:05Z",
        },
      }));
    });
    expect(await screen.findByText("已回答")).toBeTruthy();
    expect(localStorage.getItem(
      "octos-learning-lesson-jobs:v1:learn-direct-lesson",
    )).toBeNull();
  });

  it("shows clarification for an incomplete composer request instead of a guessed course", async () => {
    sessionFilesMock.invokeSkillAction.mockResolvedValueOnce({
      action_id: "learning.lesson.generate",
      ok: true,
      queued: 1,
      jobs: [{
        job_id: "text-clarify-job",
        batch_id: "text-clarify-batch",
        profile_id: "alan0x",
        session_id: "learn-text-clarify",
        action_id: "learning.lesson.generate",
        skill_id: "learning-coach",
        status: "queued",
        created_at: "2026-08-23T00:00:00Z",
        updated_at: "2026-08-23T00:00:00Z",
      }],
    });
    render(
      <LearningWorkspace
        sessionId="learn-text-clarify"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("输入学习问题"), {
      target: { value: "The book." },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送问题" }));
    await waitFor(() => expect(sessionFilesMock.invokeSkillAction).toHaveBeenCalled());
    const turnId = sessionFilesMock.invokeSkillAction.mock.calls[0]?.[2]?.turn_id;
    expect(turnId).toEqual(expect.any(String));

    act(() => {
      window.dispatchEvent(new CustomEvent("crew:skill_action_job_updated", {
        detail: {
          job_id: "text-clarify-job",
          batch_id: "text-clarify-batch",
          profile_id: "alan0x",
          session_id: "learn-text-clarify",
          action_id: "learning.lesson.generate",
          skill_id: "learning-coach",
          status: "succeeded",
          result: {
            success: true,
            output: "你想了解这本书的哪一方面？",
            structured_metadata: {
              lesson_disposition: "clarify",
              learner_response: "你想了解这本书的哪一方面？",
            },
          },
          created_at: "2026-08-23T00:00:00Z",
          updated_at: "2026-08-23T00:00:02Z",
        },
      }));
    });

    expect(await screen.findByText("你想了解这本书的哪一方面？"))
      .toBeTruthy();
    expect(await screen.findByText("已回答")).toBeTruthy();
    expect(screen.queryByLabelText(
      /正在搭建这节课。先整理重点，再把讲解和互动画面放到白板上/,
    )).toBeNull();
    expect(screen.queryByTestId("oll-controls")).toBeNull();
    expect(screen.queryByText("这块白板会保存我们的思考过程"))
      .toBeNull();
    expect(screen.queryByText("向 Octos 提问，我们从这里开始"))
      .toBeNull();
  });

  it("restores a direct lesson job after the page reloads", async () => {
    localStorage.setItem(
      "octos-learning-lesson-jobs:v1:learn-restored-job",
      JSON.stringify([{
        jobId: "lesson-job-restored",
        turnId: "lesson-turn-restored",
        referenceIds: [],
      }]),
    );
    localStorage.setItem(
      "octos-learning-questions:v1:learn-restored-job",
      JSON.stringify([{
        id: "lesson-turn-restored",
        sessionId: "learn-restored-job",
        text: "请解释自然对数的由来",
        origin: "composer",
        createdAt: "2026-08-19T00:00:00Z",
        status: "pending",
      }]),
    );
    sessionFilesMock.listSkillActionJobs.mockResolvedValueOnce([{
      job_id: "lesson-job-restored",
      batch_id: "lesson-batch-restored",
      profile_id: "alan0x",
      session_id: "learn-restored-job",
      action_id: "learning.lesson.generate",
      skill_id: "learning-coach",
      status: "succeeded",
      created_at: "2026-08-19T00:00:00Z",
      updated_at: "2026-08-19T00:00:10Z",
    }]);

    render(
      <LearningWorkspace
        sessionId="learn-restored-job"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    expect(await screen.findByText("已回答")).toBeTruthy();
    expect(sessionFilesMock.listSkillActionJobs).toHaveBeenCalledWith(
      "learn-restored-job",
      { actionId: "learning.lesson.generate" },
    );
    expect(localStorage.getItem(
      "octos-learning-lesson-jobs:v1:learn-restored-job",
    )).toBeNull();
  });

  it("does not speak a generic reply for a voice turn with no learner transcript", async () => {
    vi.useFakeTimers();
    const genericReply = "好的，你看看还有其他题目需要讲解吗？";
    conversationMock.turns = [{
      id: "empty-voice-turn",
      userText: "",
      assistantText: genericReply,
      awaitingTranscript: true,
    }];
    const view = render(
      <LearningWorkspace
        sessionId="learn-empty-voice-turn"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    act(() => {
      conversationMock.options?.onTurnComplete?.("empty-voice-turn");
      view.rerender(
        <LearningWorkspace
          sessionId="learn-empty-voice-turn"
          voiceEnabled
          onBack={vi.fn()}
        />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(2_600);
    });

    expect(screen.queryByText(genericReply)).toBeNull();
    expect(narrationTtsMock.useOllNarrationTts).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: genericReply }),
    );
    expect(screen.queryByText(/本轮没有更新白板/)).toBeNull();
  });

  it("waits for a delayed transcript before classifying the completed reply", async () => {
    vi.useFakeTimers();
    const assistantReply = "我们先把根式里面的十八分解成九乘二。";
    conversationMock.turns = [{
      id: "late-transcript-turn",
      userText: "",
      assistantText: assistantReply,
      awaitingTranscript: true,
    }];
    const view = render(
      <LearningWorkspace
        sessionId="learn-late-transcript"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    act(() => {
      conversationMock.options?.onTurnComplete?.("late-transcript-turn");
      view.rerender(
        <LearningWorkspace
          sessionId="learn-late-transcript"
          voiceEnabled
          onBack={vi.fn()}
        />,
      );
      vi.advanceTimersByTime(5_000);
    });
    expect(narrationTtsMock.useOllNarrationTts).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: assistantReply }),
    );

    conversationMock.turns = [{
      id: "late-transcript-turn",
      userText: "根号十八减根号二怎么算",
      assistantText: assistantReply,
      awaitingTranscript: false,
    }];
    view.rerender(
      <LearningWorkspace
        sessionId="learn-late-transcript"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(2_600);
    });

    expect(narrationTtsMock.useOllNarrationTts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        playing: true,
        text: assistantReply,
        narrationId: "plain-reply:late-transcript-turn",
      }),
    );
  });

  it("suspends voice capture in the render that starts OLL playback", () => {
    render(
      <LearningWorkspace
        sessionId="learn-voice-playback-ownership"
        voiceEnabled
        ollFixture="geometry-v2"
        onBack={vi.fn()}
      />,
    );

    expect(conversationMock.options?.externalSpeechActive).toBe(true);
    expect(conversationMock.options?.externalSpeechReleaseDelayMs).toBe(1200);
    expect(
      conversationMock.optionsHistory.every(
        (options) => options.externalSpeechActive === true,
      ),
    ).toBe(true);
  });

  it("keeps lesson narration active while the student moves a variable control", async () => {
    render(
      <LearningWorkspace
        sessionId="learn-student-control-during-narration"
        voiceEnabled
        ollFixture="unit-circle-sine"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(narrationTtsMock.useOllNarrationTts).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: true,
          playing: true,
          narrationId: expect.any(String),
        }),
      );
    });
    expect(screen.queryByRole("slider", { name: "旋转角 θ" })).toBeNull();
    const pendingNarration = narrationTtsMock.useOllNarrationTts.mock.calls
      .at(-1)?.[0];
    act(() => {
      pendingNarration?.onPlaybackStart?.(pendingNarration.narrationId!);
    });

    const slider = await screen.findByRole("slider", { name: "旋转角 θ" });
    const initialNarration = narrationTtsMock.useOllNarrationTts.mock.calls.at(-1)?.[0];
    fireEvent.pointerDown(slider, { pointerType: "mouse" });
    fireEvent.change(slider, { target: { value: String(Math.PI / 2) } });
    fireEvent.pointerUp(slider, { pointerType: "mouse" });

    await waitFor(() => {
      expect(narrationTtsMock.useOllNarrationTts).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: true,
          playing: true,
          narrationId: initialNarration?.narrationId,
        }),
      );
    });
    expect(conversationMock.options?.externalSpeechActive).toBe(true);
  });

  it("suspends voice capture and locks sibling sends while a text turn is pending", async () => {
    let releaseLessonStart!: () => void;
    sessionFilesMock.invokeSkillAction.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseLessonStart = resolve;
      });
      return {
        action_id: "learning.lesson.generate",
        ok: true,
        results: [],
        jobs: [],
      };
    });
    render(
      <LearningWorkspace
        sessionId="learn-text-voice-exclusion"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "输入学习问题" });
    expect(conversationMock.options?.externalSpeechActive).toBe(false);

    fireEvent.change(input, { target: { value: "请讲解单位圆" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(sessionFilesMock.invokeSkillAction).toHaveBeenCalledWith(
        "learn-text-voice-exclusion",
        "learning.lesson.generate",
        expect.objectContaining({ learner_request: "请讲解单位圆" }),
      );
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(conversationMock.options?.externalSpeechActive).toBe(true);
    expect((input as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      releaseLessonStart();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(conversationMock.options?.externalSpeechActive).toBe(false);
      expect((input as HTMLInputElement).disabled).toBe(false);
    });
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

    expect(
      screen.getByRole("button", { name: "打开本课目录" }),
    ).toBeTruthy();
    expect(screen.getByText("课程播放中")).toBeTruthy();
    expect(screen.queryByText("轻触开始")).toBeNull();
    act(() => vi.advanceTimersByTime(260));
    act(() => {
      screen.getByRole("button", { name: "打开本课目录" }).click();
    });
    expect(screen.getByRole("dialog", { name: "本课目录" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "暂停 OLL 课程" })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /查看步骤：/ }).length,
    ).toBeGreaterThan(0);
    const expandStep = screen.getAllByRole(
      "button",
      { name: /展开.+的讲解片段/ },
    )[0]!;
    act(() => expandStep.click());
    expect(
      screen.getAllByRole("button", { name: /查看讲解片段：/ }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: /从步骤开始播放：/ }).length,
    ).toBeGreaterThan(0);
    act(() => {
      screen.getAllByRole("button", { name: /查看讲解片段：/ })[0]!.click();
    });
    expect(screen.queryByRole("dialog", { name: "本课目录" })).toBeNull();
  });

  it.each([
    ["text", false],
    ["voice", true],
  ] as const)(
    "enables the shared OLL narration path in %s input mode",
    (_mode, voiceEnabled) => {
      render(
        <LearningWorkspace
          sessionId={`learn-narration-${_mode}`}
          voiceEnabled={voiceEnabled}
          ollFixture="geometry-v2"
          onBack={vi.fn()}
        />,
      );

      expect(narrationTtsMock.useOllNarrationTts).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          onSpeakingChange: expect.any(Function),
        }),
      );
    },
  );

  it("animates the teacher while the next lesson Beat is preparing", () => {
    narrationTtsMock.useOllNarrationTts.mockReturnValue({
      error: null,
      preparing: true,
    });
    render(
      <LearningWorkspace
        sessionId="learn-narration-preparing"
        voiceEnabled
        ollFixture="geometry-v2"
        onBack={vi.fn()}
      />,
    );

    const teacher = screen.getByRole("button", {
      name: "Octos 正在准备下一步",
    });
    expect(teacher.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("稍等一下")).toBeTruthy();
  });

  it("restarts TTS on a saved lesson and opens a clean ink document", async () => {
    render(
      <LearningWorkspace
        sessionId="learn-narration-review"
        playbackMode="review"
        ollFixture="geometry-v2"
        onBack={vi.fn()}
      />,
    );

    expect(narrationTtsMock.useOllNarrationTts).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, playing: false }),
    );

    fireEvent.click(screen.getByRole("button", {
      name: "重新播放 OLL 课程",
    }));

    await waitFor(() => {
      expect(narrationTtsMock.useOllNarrationTts).toHaveBeenLastCalledWith(
        expect.objectContaining({
          enabled: true,
          playing: true,
          narrationId: expect.any(String),
          text: expect.stringMatching(/\S/),
        }),
      );
    });
    expect(localStorage.getItem(
      "octos-learning-ink-run:v1:learn-narration-review",
    )).toBe("1");
    expect(localStorage.getItem(
      "octos-learning-ink-merge-source:v1:learn-narration-review",
    )).toBe("learn-narration-review");
    await waitFor(() => {
      expect(inkRuntimeMock.mountInkRuntime).toHaveBeenLastCalledWith(
        expect.objectContaining({
          storageKey:
            "octos-learning-ink:v1:learn-narration-review:replay:1",
          documentId:
            "learning-session:learn-narration-review:replay:1:student-ink",
        }),
      );
    });
    expect(inkRuntimeMock.mountInkRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: "octos-learning-ink:v1:learn-narration-review",
        documentId: "learning-session:learn-narration-review:student-ink",
      }),
    );
  });

  it("opens a clean ink document when a saved step is replayed from the course outline", async () => {
    const sessionId = "learn-outline-step-replay";
    render(
      <LearningWorkspace
        sessionId={sessionId}
        playbackMode="review"
        ollFixture="geometry-v2"
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开本课目录" }));
    fireEvent.click(screen.getAllByRole("button", {
      name: /从步骤开始播放：/,
    })[0]!);

    expect(localStorage.getItem(
      `octos-learning-ink-run:v1:${sessionId}`,
    )).toBe("1");
    expect(localStorage.getItem(
      `octos-learning-ink-merge-source:v1:${sessionId}`,
    )).toBe(sessionId);
    await waitFor(() => {
      expect(inkRuntimeMock.mountInkRuntime).toHaveBeenLastCalledWith(
        expect.objectContaining({
          storageKey: `octos-learning-ink:v1:${sessionId}:replay:1`,
          documentId:
            `learning-session:${sessionId}:replay:1:student-ink`,
        }),
      );
    });
  });

  it("restores earlier ink into the current document after replay completes", async () => {
    localStorage.setItem(
      "octos-learning-ink-run:v1:learn-finished-replay",
      "1",
    );
    localStorage.setItem(
      "octos-learning-ink-merge-source:v1:learn-finished-replay",
      "learn-finished-replay",
    );

    render(
      <LearningWorkspace
        sessionId="learn-finished-replay"
        playbackMode="review"
        ollFixture="geometry-v2"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      const currentInk = inkRuntimeMock.mountInkRuntime.mock.results.at(-1)?.value;
      expect(currentInk?.mergeSavedDocument).toHaveBeenCalledWith(
        "octos-learning-ink:v1:learn-finished-replay",
        "learning-session:learn-finished-replay:student-ink",
      );
    });
    await waitFor(() => {
      expect(localStorage.getItem(
        "octos-learning-ink-merge-source:v1:learn-finished-replay",
      )).toBeNull();
    });
    expect(localStorage.getItem(
      "octos-learning-ink-cumulative-run:v1:learn-finished-replay",
    )).toBe("1");
    expect(inkRuntimeMock.mountInkRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey:
          "octos-learning-ink:v1:learn-finished-replay:replay:1",
      }),
    );
  });

  it("hides selection questions with the ink during replay and restores them together", async () => {
    const sessionId = "learn-replay-student-additions";
    localStorage.setItem(
      `octos-learning-questions:v1:${sessionId}`,
      JSON.stringify([{
        id: "selection-question",
        sessionId,
        text: "解释我后来圈出的这一部分",
        origin: "selection",
        createdAt: "2026-08-17T12:00:00.000Z",
        status: "answered",
        source: {
          sourceId: "selection-source",
          bounds: { x: 20, y: 30, width: 120, height: 80 },
        },
      }, {
        id: "composer-question",
        sessionId,
        text: "最初发起课程的问题",
        origin: "composer",
        createdAt: "2026-08-17T11:00:00.000Z",
        status: "answered",
        position: { x: 10, y: 10 },
      }]),
    );
    localStorage.setItem(`octos-learning-ink-run:v1:${sessionId}`, "1");
    localStorage.setItem(
      `octos-learning-ink-merge-source:v1:${sessionId}`,
      sessionId,
    );
    let finishMerge!: () => void;
    const mergePending = new Promise<void>((resolve) => {
      finishMerge = resolve;
    });
    inkRuntimeMock.mountInkRuntime.mockImplementation(() => {
      const state = {
        mode: "navigate" as const,
        component_count: 0,
        selected_count: 0,
        pen_color: "#176b62",
        selection_color: null,
        selection_input: "unknown" as const,
        selection_mode: "rectangle" as const,
        selection_revision: 0,
        document_version: 0,
        saved: true,
      };
      return {
        ready: Promise.resolve(),
        state,
        subscribe: vi.fn((listener: (next: typeof state) => void) => {
          listener(state);
          return () => undefined;
        }),
        setMode: vi.fn(),
        setPenColor: vi.fn(),
        setSelectionColor: vi.fn(),
        setSelectionMode: vi.fn(),
        selectAll: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        mergeSavedDocument: vi.fn(() => mergePending),
        destroy: vi.fn(async () => undefined),
      };
    });

    render(
      <LearningWorkspace
        sessionId={sessionId}
        playbackMode="review"
        ollFixture="geometry-v2"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText("最初发起课程的问题")).toBeTruthy();
    expect(screen.queryByText("解释我后来圈出的这一部分")).toBeNull();

    await act(async () => {
      finishMerge();
      await mergePending;
    });

    expect(await screen.findByText("解释我后来圈出的这一部分")).toBeTruthy();
  });

  it("recovers ink hidden by the previous replay implementation once", async () => {
    localStorage.setItem(
      "octos-learning-ink-run:v1:learn-legacy-replay",
      "1",
    );

    const view = render(
      <LearningWorkspace
        sessionId="learn-legacy-replay"
        playbackMode="review"
        ollFixture="geometry-v2"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      const currentInk = inkRuntimeMock.mountInkRuntime.mock.results.at(-1)?.value;
      expect(currentInk?.mergeSavedDocument).toHaveBeenCalledWith(
        "octos-learning-ink:v1:learn-legacy-replay",
        "learning-session:learn-legacy-replay:student-ink",
      );
    });
    await waitFor(() => {
      expect(localStorage.getItem(
        "octos-learning-ink-cumulative-run:v1:learn-legacy-replay",
      )).toBe("1");
    });

    view.unmount();
    inkRuntimeMock.mountInkRuntime.mockClear();
    render(
      <LearningWorkspace
        sessionId="learn-legacy-replay"
        playbackMode="review"
        ollFixture="geometry-v2"
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(inkRuntimeMock.mountInkRuntime).toHaveBeenCalled());
    const restoredInk = inkRuntimeMock.mountInkRuntime.mock.results.at(-1)?.value;
    expect(restoredInk?.mergeSavedDocument).not.toHaveBeenCalled();
  });

  it("loads a delivered OLL Authoring artifact into the /learn Runtime", async () => {
    const fallbackReply = "这是主模型额外生成的完整文本讲解，不应显示在教师气泡里。";
    conversationMock.turns = [{
      id: "client-turn",
      userText: "讲解",
      assistantText: fallbackReply,
      awaitingTranscript: false,
    }];
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
    await waitFor(() => expect(localStorage.getItem(
      "octos-learning-questions:v1:learn-model-test",
    )).toContain('"id":"server-turn"'));
    expect(localStorage.getItem(
      "octos-learning-questions:v1:learn-model-test",
    )).toContain('"text":"讲解"');
    await waitFor(() => {
      const regions = JSON.parse(localStorage.getItem(
        "octos-learning-course-regions:v1:learn-model-test",
      ) ?? "[]") as Array<{
        questionId: string;
        origin: { x: number; y: number };
      }>;
      expect(regions.some((region) => region.questionId === "server-turn"))
        .toBe(true);
      return regions;
    });
    act(() => {
      conversationMock.options?.onTurnComplete?.("client-turn");
    });
    expect(screen.queryByText(fallbackReply)).toBeNull();
    expect(narrationTtsMock.useOllNarrationTts).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: fallbackReply }),
    );
    expect(
      screen.queryByText("课程已经写到白板上，我们开始吧。"),
    ).toBeNull();
  });

  it("does not turn a local selection enhancement into TTS narration", async () => {
    vi.useFakeTimers();
    const fallbackReply = "这是选区旁边的局部解释，不是一节需要朗读的课程。";
    conversationMock.turns = [{
      id: "selection-turn",
      userText: "解释这里",
      assistantText: fallbackReply,
      awaitingTranscript: false,
    }];
    conversationMock.threads = [{
      id: "selection-turn",
      turnId: "selection-turn",
      userMsg: {
        id: "selection-user",
        role: "user",
        text: "解释这里",
        files: [],
        toolCalls: [],
        status: "complete",
        timestamp: 1,
      },
      responses: [{
        id: "selection-assistant",
        role: "assistant",
        text: fallbackReply,
        files: [{
          filename: "selection-turn.octos-selection-enhancement.json",
          path: "study/oll/selection-turn.octos-selection-enhancement.json",
        }],
        toolCalls: [],
        status: "complete",
        timestamp: 2,
      }],
      pendingAssistant: null,
    }];
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));

    const view = render(
      <LearningWorkspace
        sessionId="learn-selection-no-tts"
        voiceEnabled
        onBack={vi.fn()}
      />,
    );

    act(() => {
      conversationMock.options?.onTurnComplete?.("selection-turn");
      view.rerender(
        <LearningWorkspace
          sessionId="learn-selection-no-tts"
          voiceEnabled
          onBack={vi.fn()}
        />,
      );
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.queryByText(/本轮没有更新白板/)).toBeNull();
    expect(narrationTtsMock.useOllNarrationTts).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: fallbackReply,
        narrationId: "plain-reply:selection-turn",
      }),
    );
  });

  it("loads a rounded selection enhancement and deletes its whole combined card", async () => {
    const sessionId = "learn-selection-rounded-bounds";
    const svg = '<svg data-oll-ink-selection="1"><path d="M0 0L10 10"/></svg>';
    const region = {
      kind: "rectangle" as const,
      closed: true,
      points: [
        { x: 523, y: 189 },
        { x: 754, y: 189 },
        { x: 754, y: 308.77777777777777 },
        { x: 523, y: 308.77777777777777 },
      ],
    };
    const componentIds = ["stroke:rounded-bounds"];
    const source = {
      format: INK_SELECTION_FORMAT,
      format_version: INK_SELECTION_FORMAT_VERSION,
      source_id: "ink-source-rounded-bounds",
      document_id: `learning-session:${sessionId}:student-ink`,
      document_version: 6,
      created_at: "2026-08-17T10:00:00.000Z",
      bounds: { x: 523, y: 189, width: 231, height: 119.77777777777777 },
      region,
      component_ids: componentIds,
      checksum: {
        algorithm: "sha-256" as const,
        value: await inkSvgChecksum(JSON.stringify({
          svg,
          region,
          component_ids: componentIds,
        })),
      },
      svg,
    } satisfies InkSelectionSnapshot;
    saveSelectionEnhancementState({
      profile: "octos.selection-enhancement-state",
      version: "0.1",
      session_id: sessionId,
      sources: [source],
      hidden_enhancement_turn_ids: [],
    });
    saveWhiteboardQuestions(sessionId, [{
      id: "plot-turn",
      sessionId,
      text: "请画出 $y=x^2$。",
      origin: "selection",
      createdAt: "2026-08-17T10:00:00.500Z",
      status: "answered",
      source: {
        sourceId: source.source_id,
        bounds: source.bounds,
      },
    }]);
    sessionFilesMock.getSessionFiles.mockResolvedValue([{
      filename: "plot-turn.octos-selection-enhancement.json",
      path: "skill-output/study/selections/plot-turn.octos-selection-enhancement.json",
      size_bytes: 900,
      modified_at: "2026-08-17T10:00:01.000Z",
    }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        profile: "octos.selection-enhancement",
        version: "0.2",
        turn_id: "plot-turn",
        created_at: "2026-08-17T10:00:01.000Z",
        source: {
          source_id: source.source_id,
          document_id: source.document_id,
          document_version: source.document_version,
          bounds: {
            ...source.bounds,
            height: source.bounds.height - 1e-12,
          },
          checksum: source.checksum,
        },
        board: {
          board_id: `learning-whiteboard:${sessionId}`,
          revision: 0,
          targets: [],
        },
        tool_id: "generate-plot",
        interpretation: {
          kind: "math",
          content: "y = x^2",
          confidence: "high",
        },
        response: {
          kind: "plot",
          title: "二次函数 y = x² 图像",
          text: "这是所选函数的图像。",
          expression: "x^2",
          x_range: { min: -5, max: 5 },
          y_range: { min: -2, max: 25 },
        },
      }),
    }));

    render(
      <LearningWorkspace
        sessionId={sessionId}
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("二次函数 y = x² 图像")).toBeTruthy();
    });
    expect(screen.queryByText("选区辅助内容无法对应到已保存的原稿快照"))
      .toBeNull();

    fireEvent.click(screen.getByRole("button", {
      name: "删除这条辅助内容",
    }));
    await waitFor(() => {
      expect(screen.queryByText("二次函数 y = x² 图像")).toBeNull();
      expect(screen.queryByText(/请画出/)).toBeNull();
    });
    expect(screen.queryByText(/正在生成选区辅助内容/)).toBeNull();
  });

  it("keeps a durable auxiliary card visible when its browser-local source is missing", async () => {
    const sessionId = "learn-selection-source-missing";
    sessionFilesMock.getSessionFiles.mockResolvedValue([{
      filename: "historical-turn.octos-selection-enhancement.json",
      path: "skill-output/study/selections/historical-turn.octos-selection-enhancement.json",
      size_bytes: 700,
      modified_at: "2026-08-17T11:00:01.000Z",
    }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        profile: "octos.selection-enhancement",
        version: "0.2",
        turn_id: "historical-turn",
        created_at: "2026-08-17T11:00:01.000Z",
        source: {
          source_id: "missing-local-source",
          document_id: `learning-session:${sessionId}:student-ink`,
          document_version: 4,
          bounds: { x: 120, y: 80, width: 180, height: 90 },
          checksum: { algorithm: "sha-256", value: "a".repeat(64) },
        },
        board: {
          board_id: `learning-whiteboard:${sessionId}`,
          revision: 0,
          targets: [],
        },
        tool_id: "explain",
        interpretation: {
          kind: "math",
          content: "y=x^2",
          confidence: "high",
        },
        response: {
          kind: "explanation",
          title: "保留下来的历史说明",
          text: "已经生成的答案仍然可以查看。",
        },
      }),
    }));

    render(
      <LearningWorkspace
        sessionId={sessionId}
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("保留下来的历史说明")).toBeTruthy();
    });
    expect(screen.getByText("原选区快照已不在本浏览器，保留生成结果"))
      .toBeTruthy();
    expect(screen.queryByText("选区辅助内容无法对应到已保存的原稿快照"))
      .toBeNull();
  });

  it("restores an OLL lesson from durable session files after refresh", async () => {
    sessionFilesMock.getSessionFiles.mockResolvedValue([
      {
        filename: "restored-turn.octos-lesson.json",
        path: "skill-output/study/oll/restored-turn.octos-lesson.json",
        size_bytes: 100,
        modified_at: "2026-07-28T15:45:27.000Z",
      },
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
        dsl: "octos.lesson",
        version: "0.1",
        profile: "authoring",
        lesson: {
          mode: "explain",
          language: "zh-CN",
          title: "刷新后恢复的课程",
          goals: ["恢复白板"],
        },
        steps: [{
          key: "restore",
          purpose: "恢复课程",
          beats: [{
            key: "restore-board",
            say: "恢复白板。",
            actions: [{
              do: "write",
              as: "restored-card",
              kind: "note",
              role: "conclusion",
              content: { text: "已恢复" },
              place: { relation: "new_region" },
            }],
          }],
        }],
        close: { summary: "恢复完成", focus: ["restored-card"] },
        }),
      }));

    render(
      <LearningWorkspace
        sessionId="learn-restored"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("刷新后恢复的课程")).toBeTruthy();
    });
    expect(sessionFilesMock.getSessionFiles).toHaveBeenCalledWith(
      "learn-restored",
    );
  });

  it("refetches durable OLL artifacts when the bridge reconnects", async () => {
    sessionFilesMock.getSessionFiles
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          filename: "reconnected-turn.octos-lesson.json",
          path: "study/oll/reconnected-turn.octos-lesson.json",
          size_bytes: 100,
          modified_at: "2026-07-28T15:45:27.000Z",
        },
      ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        dsl: "octos.lesson",
        version: "0.1",
        profile: "authoring",
        lesson: {
          mode: "explain",
          language: "zh-CN",
          title: "重连后恢复的课程",
          goals: ["恢复漏掉的白板文件事件"],
        },
        steps: [{
          key: "restore",
          purpose: "恢复课程",
          beats: [{
            key: "restore-board",
            say: "重新读取白板课程。",
            actions: [{
              do: "write",
              as: "reconnected-card",
              kind: "note",
              role: "conclusion",
              content: { text: "重连恢复成功" },
              place: { relation: "new_region" },
            }],
          }],
        }],
        close: { summary: "恢复完成", focus: ["reconnected-card"] },
      }),
    }));

    render(
      <LearningWorkspace
        sessionId="learn-reconnected"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(sessionFilesMock.getSessionFiles).toHaveBeenCalledTimes(1),
    );
    expect(screen.queryByTestId("oll-controls")).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent("crew:bridge_connected"));
    });

    await waitFor(() => {
      expect(sessionFilesMock.getSessionFiles).toHaveBeenCalledTimes(2);
      expect(screen.getByText("重连后恢复的课程")).toBeTruthy();
    });
  });

  it("loads the first playable lesson section while the generation tool is still running", async () => {
    const part0File = {
      filename: "progressive-turn.part-000.octos-lesson.json",
      path: "study/oll/progressive-turn.part-000.octos-lesson.json",
      size_bytes: 100,
      modified_at: "2026-08-14T16:00:00.000Z",
    };
    const part1File = {
      filename: "progressive-turn.part-001.octos-lesson.json",
      path: "study/oll/progressive-turn.part-001.octos-lesson.json",
      size_bytes: 200,
      modified_at: "2026-08-14T16:00:01.000Z",
    };
    sessionFilesMock.getSessionFiles
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([part0File])
      .mockResolvedValue([part0File, part1File]);
    const partialLesson = {
      dsl: "octos.lesson",
      version: "0.1",
      profile: "authoring",
      lesson: {
        mode: "explain",
        language: "zh-CN",
        title: "先到达的第一节",
        goals: ["先播放已经完成的部分"],
      },
      steps: [{
        key: "observe",
        purpose: "先观察",
        beats: [{
          key: "first-board",
          say: "我们先看第一部分。",
          actions: [{
            do: "write",
            as: "first-card",
            kind: "note",
            role: "concept",
            content: { text: "第一部分已经准备好" },
            place: { relation: "new_region" },
          }],
        }],
      }],
      close: { summary: "第一部分完成", focus: ["first-card"] },
    };
    const secondStep = {
      key: "explain",
      purpose: "继续解释",
      beats: [{
        key: "second-board",
        say: "现在继续第二部分。",
        actions: [{
          do: "write",
          as: "second-card",
          kind: "note",
          role: "concept",
          content: { title: "第二部分", items: ["第二部分也已经准备好"] },
          place: { relation: "below", anchor: "first-card" },
        }],
      }],
    };
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes("part-001")
        ? { ...partialLesson, steps: [...partialLesson.steps, secondStep] }
        : partialLesson,
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LearningWorkspace
        sessionId="learn-progressive"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(sessionFilesMock.getSessionFiles).toHaveBeenCalledTimes(1),
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("crew:tool_progress", {
        detail: {
          sessionId: "learn-progressive",
          tool: "oll_generate_lesson",
          message: "[artifact:oll_lesson_part] part=0 (study/oll/progressive-turn.part-000.octos-lesson.json)",
          terminal: false,
        },
      }));
    });

    await waitFor(() => {
      expect(sessionFilesMock.getSessionFiles).toHaveBeenCalledTimes(2);
      expect(screen.getByText("先到达的第一节")).toBeTruthy();
      expect(screen.getByTestId("oll-controls")).toBeTruthy();
      expect(screen.getByLabelText("课程内容仍在生成")).toBeTruthy();
      expect(screen.queryByText("正在补充白板内容")).toBeNull();
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("crew:tool_progress", {
        detail: {
          sessionId: "learn-progressive",
          tool: "oll_generate_lesson",
          message: "[artifact:oll_lesson_part] part=1 (study/oll/progressive-turn.part-001.octos-lesson.json)",
          terminal: false,
        },
      }));
    });
    await waitFor(() => {
      expect(sessionFilesMock.getSessionFiles).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes("part-001.octos-lesson.json"))).toBe(true);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("crew:tool_progress", {
        detail: {
          sessionId: "learn-progressive",
          tool: "oll_generate_lesson",
          message: "lesson generation completed",
          terminal: true,
        },
      }));
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("课程内容仍在生成")).toBeNull();
    });
  });

  it("does not infer an OLL path when the durable file list is empty", async () => {
    sessionFilesMock.getSessionFiles.mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LearningWorkspace
        sessionId="learn-no-artifact"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(sessionFilesMock.getSessionFiles).toHaveBeenCalledWith(
        "learn-no-artifact",
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("oll-controls")).toBeNull();
    expect(screen.getByText("向 Octos 提问，我们从这里开始")).toBeTruthy();
  });

  it("surfaces a durable file-list failure without falling back to prose", async () => {
    conversationMock.turns = [{
      id: "turn-with-prose",
      userText: "讲解负数乘法",
      assistantText: "这段普通文本不能替代 OLL 课程。",
      awaitingTranscript: false,
    }];
    sessionFilesMock.getSessionFiles.mockRejectedValue(
      new Error("白板文件列表暂不可用"),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LearningWorkspace
        sessionId="learn-file-list-error"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "白板文件列表暂不可用",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("这段普通文本不能替代 OLL 课程。")).toBeNull();
    expect(screen.queryByTestId("oll-controls")).toBeNull();
  });

  it("keeps loading an OLL artifact while later assistant deltas rerender the thread", async () => {
    const makeThread = (assistantText: string): Thread => ({
      id: "client-streaming-turn",
      turnId: "server-streaming-turn",
      userMsg: {
        id: "streaming-user",
        role: "user",
        text: "讲解负数乘法",
        files: [],
        toolCalls: [],
        status: "complete",
        timestamp: 1,
      },
      responses: [{
        id: "artifact-only-assistant",
        role: "assistant",
        text: "",
        files: [{
          filename: "server-streaming-turn.octos-lesson.json",
          path: "skill-output/study/oll/server-streaming-turn.octos-lesson.json",
        }],
        toolCalls: [],
        status: "complete",
        timestamp: 2,
      }, {
        id: "streaming-assistant",
        role: "assistant",
        text: assistantText,
        files: [],
        toolCalls: [],
        status: "complete",
        timestamp: 3,
      }],
      pendingAssistant: null,
    });
    conversationMock.threads = [makeThread("白板已经准备好")];

    let resolveFetch!: (value: {
      ok: boolean;
      json: () => Promise<unknown>;
    }) => void;
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise((resolve, reject) => {
        resolveFetch = resolve;
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }));

    const view = render(
      <LearningWorkspace
        sessionId="learn-streaming-artifact-test"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => expect(requestSignal).toBeTruthy());
    conversationMock.threads = [makeThread(
      "白板已经准备好，下面是模型仍在继续流式输出的长文本。",
    )];
    view.rerender(
      <LearningWorkspace
        sessionId="learn-streaming-artifact-test"
        voiceEnabled={false}
        onBack={vi.fn()}
      />,
    );

    expect(requestSignal?.aborted).toBe(false);
    resolveFetch({
      ok: true,
      json: async () => ({
        dsl: "octos.lesson",
        version: "0.1",
        profile: "authoring",
        lesson: {
          mode: "explain",
          language: "zh-CN",
          title: "流式回复中的 OLL 课程",
          goals: ["解释负数乘法"],
        },
        steps: [{
          key: "explain",
          purpose: "写出核心结论",
          beats: [{
            key: "write",
            say: "先看规律。",
            actions: [{
              do: "write",
              as: "answer",
              kind: "note",
              role: "conclusion",
              content: { text: "负负得正" },
              place: { relation: "new_region", region_role: "lesson_origin" },
            }],
          }],
        }],
        close: { summary: "完成讲解", focus: ["answer"] },
      }),
    });

    await waitFor(() => {
      expect(screen.getByText("流式回复中的 OLL 课程")).toBeTruthy();
      expect(screen.getByTestId("oll-controls")).toBeTruthy();
    });
  });
});
