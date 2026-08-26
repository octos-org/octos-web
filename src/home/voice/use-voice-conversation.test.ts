import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  assembleTurnFiles,
  buildVoiceTurns,
  collectFreshAudio,
  collectFreshAudioWithTurnIds,
  collectFreshVisuals,
  farewellAudioActive,
  hasVisualMarker,
  pickFreshAudio,
  shouldHandleExitEvent,
  shouldHandleNoSpeechEvent,
  stripVisualMarker,
  useVoiceConversation,
  type VoiceTurnSendContext,
} from "./use-voice-conversation";
import type { Thread } from "@/store/thread-store";
import * as VoiceTranscriptStore from "@/store/voice-transcript-store";

// ---------------------------------------------------------------------------
// Hook-level harness (start() cancellation — post-unmount mic re-acquire).
// The pure-function suites below don't touch these mocks.
// ---------------------------------------------------------------------------

const {
  captureStartMock,
  captureStopMock,
  getActiveBridgeMock,
  sendMessageMock,
  supportsVoiceAdmissionMock,
  admitVoiceMessageMock,
  commitAdmittedVoiceMessageMock,
  interruptActiveTurnMock,
  uploadFilesMock,
} = vi.hoisted(() => ({
  captureStartMock: vi.fn(async () => {}),
  captureStopMock: vi.fn(async () => {}),
  getActiveBridgeMock: vi.fn((): unknown => undefined),
  sendMessageMock: vi.fn(),
  supportsVoiceAdmissionMock: vi.fn(() => true),
  admitVoiceMessageMock: vi.fn(async () => ({
    status: "speech" as const,
    admissionId: "admission-1",
    transcript: "你好",
  })),
  commitAdmittedVoiceMessageMock: vi.fn(async () => ({ accepted: true })),
  interruptActiveTurnMock: vi.fn(async () => true),
  uploadFilesMock: vi.fn(async () => [] as string[]),
}));

vi.mock("./use-voice-capture", () => ({
  // Stable object — the hook destructures start/stop and depends on their
  // identity staying constant across renders (mirrors the real hook's
  // useCallback([])-stable fns).
  useVoiceCapture: () => ({
    capturing: false,
    start: captureStartMock,
    stop: captureStopMock,
    error: null,
  }),
}));

const cameraMock = vi.hoisted(() => ({
  active: false,
  stream: null,
  error: null,
  start: vi.fn(async () => true),
  stop: vi.fn(),
  grabFrame: vi.fn(async () => null),
  settings: {
    rotation: 0,
    mirror: false,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    documentMode: true,
  },
  updateSettings: vi.fn(),
  resetSettings: vi.fn(),
}));

vi.mock("./use-camera-frame", () => ({
  useCameraFrame: () => cameraMock,
}));

// Behavioural audio-playback mock mirroring the real module's contract:
// `playAudioBlob` parks the clip's completion callback (playback "runs" until
// something fires it); `stopAudio` fires it exactly once, so `playOne`'s
// await resolves on interrupt just like the real implementation.
const audioMock = vi.hoisted(() => {
  const state = { onEnded: null as null | (() => void) };
  return {
    state,
    playAudioBlob: vi.fn(async (_blob: Blob, onEnded: () => void) => {
      state.onEnded = onEnded;
      return true;
    }),
    stopAudio: vi.fn(() => {
      const f = state.onEnded;
      state.onEnded = null;
      f?.();
    }),
    unlockAudio: vi.fn(),
  };
});

vi.mock("./audio-playback", () => ({
  playAudioBlob: audioMock.playAudioBlob,
  stopAudio: audioMock.stopAudio,
  unlockAudio: audioMock.unlockAudio,
}));

const threadsMock = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock("@/store/projection-render-adapter", () => ({
  useRenderThreads: () => threadsMock.value,
}));

const projectionStoreMock = vi.hoisted(() => ({
  listener: null as
    | null
    | ((storeKey: string, envelope: Record<string, unknown>) => void),
}));

vi.mock("@/store/projection-store", () => ({
  projectionStoreKey: (sessionId: string, topic?: string) =>
    `${sessionId}\u0000${topic ?? ""}`,
  clientMessageIdForTurn: (_storeKey: string, turnId: string) => turnId,
  onEnvelopeObserved: (
    listener: (storeKey: string, envelope: Record<string, unknown>) => void,
  ) => {
    projectionStoreMock.listener = listener;
    return () => {
      if (projectionStoreMock.listener === listener) {
        projectionStoreMock.listener = null;
      }
    };
  },
}));

vi.mock("@/runtime/ui-protocol-send", () => ({
  admitVoiceMessage: admitVoiceMessageMock,
  commitAdmittedVoiceMessage: commitAdmittedVoiceMessageMock,
  interruptActiveTurn: interruptActiveTurnMock,
  sendMessage: sendMessageMock,
  supportsVoiceAdmission: supportsVoiceAdmissionMock,
}));

vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: getActiveBridgeMock,
}));

vi.mock("@/api/chat", () => ({
  uploadFiles: uploadFilesMock,
}));

vi.mock("@/api/files", () => ({
  buildFileUrl: (p: string) => p,
}));

vi.mock("@/api/client", () => ({
  buildApiHeaders: () => ({}),
}));

afterEach(() => {
  supportsVoiceAdmissionMock.mockReset();
  supportsVoiceAdmissionMock.mockReturnValue(true);
  admitVoiceMessageMock.mockReset();
  admitVoiceMessageMock.mockResolvedValue({
    status: "speech",
    admissionId: "admission-1",
    transcript: "你好",
  });
  commitAdmittedVoiceMessageMock.mockReset();
  commitAdmittedVoiceMessageMock.mockResolvedValue({ accepted: true });
});

describe("assembleTurnFiles", () => {
  const audio = new File(["a"], "utterance.wav", { type: "audio/wav" });
  const frame = new File(["f"], "frame.jpg", { type: "image/jpeg" });

  it("sends audio only when the camera is disabled", async () => {
    const grab = vi.fn();
    const files = await assembleTurnFiles(audio, false, grab);
    expect(files).toEqual([audio]);
    expect(grab).not.toHaveBeenCalled();
  });

  it("appends the frame when the camera is enabled", async () => {
    const grab = vi.fn().mockResolvedValue(frame);
    const files = await assembleTurnFiles(audio, true, grab);
    expect(files).toEqual([audio, frame]);
  });

  it("falls back to audio only when grabFrame returns null", async () => {
    const grab = vi.fn().mockResolvedValue(null);
    const files = await assembleTurnFiles(audio, true, grab);
    expect(files).toEqual([audio]);
  });
});

describe("pickFreshAudio", () => {
  it("returns latest unplayed assistant audio file", () => {
    const threads = [
      { responses: [{ role: "assistant", text: "hi", files: [{ path: "a/r1.wav" }] }] },
      { responses: [{ role: "assistant", text: "yo", files: [{ path: "a/r2.wav" }] }] },
    ] as unknown as Thread[];
    const got = pickFreshAudio(threads, new Set(["a/r1.wav"]));
    expect(got).toEqual({ path: "a/r2.wav", text: "yo" });
  });
  it("returns null when all audio already played", () => {
    const threads = [
      { responses: [{ role: "assistant", text: "hi", files: [{ path: "a/r1.wav" }] }] },
    ] as unknown as Thread[];
    expect(pickFreshAudio(threads, new Set(["a/r1.wav"]))).toBeNull();
  });

  it("can skip audio from interrupted turns", () => {
    const threads = [
      {
        id: "old-turn",
        responses: [
          { role: "assistant", text: "old", files: [{ path: "a/old.wav" }] },
        ],
      },
      {
        id: "new-turn",
        responses: [
          { role: "assistant", text: "new", files: [{ path: "a/new.wav" }] },
        ],
      },
    ] as unknown as Thread[];

    expect(collectFreshAudio(threads, new Set(), new Set(["old-turn"]))).toEqual([
      { path: "a/new.wav", text: "new" },
    ]);
  });

  it("keeps turn ids for playback interruption bookkeeping", () => {
    const threads = [
      {
        id: "turn-1",
        responses: [
          { role: "assistant", text: "old", files: [{ path: "a/old.wav" }] },
        ],
      },
    ] as unknown as Thread[];

    expect(collectFreshAudioWithTurnIds(threads, new Set())).toEqual([
      { path: "a/old.wav", text: "old", turnId: "turn-1" },
    ]);
  });
});

describe("buildVoiceTurns", () => {
  it("shows a provisional ASR turn before any canonical thread exists", () => {
    expect(
      buildVoiceTurns(
        [],
        0,
        new Map([["turn-provisional", "先显示识别文字"]]),
        ["turn-provisional"],
      ),
    ).toEqual([
      {
        id: "turn-provisional",
        userText: "先显示识别文字",
        assistantText: "",
        awaitingTranscript: false,
      },
    ]);
  });

  it("uses a live ASR transcript when the canonical user row is still empty", () => {
    const threads = [
      {
        id: "turn-1",
        userMsg: { text: "", files: [{ path: "uploads/utterance.wav" }] },
        pendingAssistant: null,
        responses: [],
      },
    ] as unknown as Thread[];

    expect(
      buildVoiceTurns(
        threads,
        0,
        new Map([["turn-1", "这是刚识别出的文字"]]),
      ),
    ).toEqual([
      {
        id: "turn-1",
        userText: "这是刚识别出的文字",
        assistantText: "",
        awaitingTranscript: false,
      },
    ]);
  });

  it("derives ASR transcript and assistant text from threads", () => {
    const threads = [
      {
        id: "turn-1",
        userMsg: { text: "今天天气怎么样", files: [] },
        pendingAssistant: null,
        responses: [
          { role: "assistant", text: "今天适合出门。", files: [] },
        ],
      },
    ] as unknown as Thread[];

    expect(buildVoiceTurns(threads)).toEqual([
      {
        id: "turn-1",
        userText: "今天天气怎么样",
        assistantText: "今天适合出门。",
        awaitingTranscript: false,
      },
    ]);
  });

  it("marks an audio-only user row as awaiting transcript", () => {
    const threads = [
      {
        id: "turn-1",
        userMsg: { text: "", files: [{ path: "uploads/utterance.wav" }] },
        pendingAssistant: null,
        responses: [],
      },
    ] as unknown as Thread[];

    expect(buildVoiceTurns(threads)).toEqual([
      {
        id: "turn-1",
        userText: "",
        assistantText: "",
        awaitingTranscript: true,
      },
    ]);
  });

  it("hides learning protocol blocks while retaining the ASR transcript", () => {
    const threads = [
      {
        id: "turn-1",
        userMsg: {
          text: "[[LEARNING_CONTEXT]]\nactive: true\nsession_id: learn-1\n[[/LEARNING_CONTEXT]]\n帮我看这一步",
          files: [{ path: "uploads/utterance.wav" }],
        },
        pendingAssistant: null,
        responses: [],
      },
    ] as unknown as Thread[];

    expect(buildVoiceTurns(threads)[0]).toEqual(
      expect.objectContaining({
        userText: "帮我看这一步",
        awaitingTranscript: false,
      }),
    );
  });
});

describe("visual marker", () => {
  it("detects a well-formed marker and ignores empty/absent", () => {
    expect(hasVisualMarker("好的。\n[[VISUAL:html|负反馈电路]]")).toBe(true);
    expect(hasVisualMarker("[[VISUAL:image|一只猫]]")).toBe(true);
    expect(hasVisualMarker("好的。\n[[VISUAL:illustrated|人类细胞结构]]")).toBe(true);
    expect(hasVisualMarker("纯口播没有标记")).toBe(false);
    expect(hasVisualMarker("[[VISUAL:html|]]")).toBe(false);
  });

  it("strips the trailing marker for display", () => {
    expect(stripVisualMarker("我给你画一个。\n[[VISUAL:html|电路]]")).toBe(
      "我给你画一个。",
    );
    expect(stripVisualMarker("没有标记")).toBe("没有标记");
  });
});

describe("collectFreshVisuals", () => {
  it("collects unseen image/html artifacts and classifies by extension", () => {
    const threads = [
      {
        id: "t1",
        responses: [
          {
            role: "assistant",
            text: "x",
            files: [
              { path: "w/reply.wav" }, // audio — ignored
              { path: "w/visual-1.html" },
              { path: "w/poster.png" },
            ],
          },
        ],
      },
    ] as unknown as Thread[];
    expect(collectFreshVisuals(threads, new Set())).toEqual([
      { path: "w/visual-1.html", kind: "html" },
      { path: "w/poster.png", kind: "image" },
    ]);
  });

  it("skips already-seen artifacts and ignored turns", () => {
    const threads = [
      {
        id: "old",
        responses: [
          { role: "assistant", text: "x", files: [{ path: "w/old.png" }] },
        ],
      },
      {
        id: "new",
        responses: [
          { role: "assistant", text: "y", files: [{ path: "w/new.html" }] },
        ],
      },
    ] as unknown as Thread[];
    expect(
      collectFreshVisuals(threads, new Set(["w/seen.png"]), new Set(["old"])),
    ).toEqual([{ path: "w/new.html", kind: "html" }]);
  });
});

describe("shouldHandleExitEvent (voice/exit dedup)", () => {
  const SESSION = "voice-123";

  it("accepts a fresh turn for this session", () => {
    const consumed = new Set<string>();
    expect(
      shouldHandleExitEvent(
        { sessionId: SESSION, turnId: "t1" },
        SESSION,
        consumed,
      ),
    ).toBe(true);
  });

  it("rejects a different session", () => {
    expect(
      shouldHandleExitEvent(
        { sessionId: "other", turnId: "t1" },
        SESSION,
        new Set(),
      ),
    ).toBe(false);
  });

  it("rejects an already-consumed turn (replay / duplicate)", () => {
    const consumed = new Set<string>(["t1"]);
    expect(
      shouldHandleExitEvent(
        { sessionId: SESSION, turnId: "t1" },
        SESSION,
        consumed,
      ),
    ).toBe(false);
  });

  it("rejects missing/empty detail", () => {
    expect(shouldHandleExitEvent(undefined, SESSION, new Set())).toBe(false);
  });

  it("accepts when turnId is absent (cannot dedup, still session-scoped)", () => {
    expect(
      shouldHandleExitEvent({ sessionId: SESSION }, SESSION, new Set(["t1"])),
    ).toBe(true);
  });
});

describe("farewellAudioActive (fallback must not cut off the goodbye)", () => {
  it("is active while a clip is playing", () => {
    expect(farewellAudioActive(true, 0, "speaking")).toBe(true);
  });

  it("is active while clips remain queued", () => {
    expect(farewellAudioActive(false, 2, "thinking")).toBe(true);
  });

  it("is active in the speaking state", () => {
    expect(farewellAudioActive(false, 0, "speaking")).toBe(true);
  });

  it("is NOT active when idle with an empty queue (already done / none)", () => {
    expect(farewellAudioActive(false, 0, "idle")).toBe(false);
    expect(farewellAudioActive(false, 0, "listening")).toBe(false);
  });

  it("is NOT active in `thinking` with an empty queue, so the no-audio case can still exit", () => {
    // A turn that produced no farewell audio sits in `thinking`; the fallback
    // timer must be allowed to leave rather than hang forever.
    expect(farewellAudioActive(false, 0, "thinking")).toBe(false);
  });
});

describe("live ASR transcript projection", () => {
  afterEach(() => {
    threadsMock.value = [];
    VoiceTranscriptStore.__resetVoiceTranscriptStoreForTests();
  });

  it("updates the visible turn before canonical history contains the transcript", () => {
    threadsMock.value = [];
    const { result, rerender, unmount } = renderHook(() =>
      useVoiceConversation("voice-live-asr"),
    );

    expect(result.current.turns).toEqual([]);

    act(() => {
      VoiceTranscriptStore.upsert(
        "voice-live-asr",
        undefined,
        "turn-live-asr",
        "提前显示这句话",
      );
    });

    expect(result.current.turns[0]).toEqual(
      expect.objectContaining({
        userText: "提前显示这句话",
        awaitingTranscript: false,
      }),
    );
    expect(result.current.lastUserText).toBe("提前显示这句话");

    threadsMock.value = [
      {
        id: "turn-live-asr",
        turnId: "turn-live-asr",
        userMsg: {
          text: "",
          files: [{ path: "uploads/utterance.wav" }],
        },
        pendingAssistant: {
          role: "assistant",
          text: "稍后出现回答",
          files: [],
        },
        responses: [],
      },
    ];
    rerender();
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0]).toEqual(
      expect.objectContaining({
        userText: "提前显示这句话",
        assistantText: "稍后出现回答",
      }),
    );
    unmount();
  });

  it("replays a transcript that arrived before the voice hook subscribed", () => {
    VoiceTranscriptStore.upsert(
      "voice-asr-before-mount",
      undefined,
      "turn-before-mount",
      "订阅之前已经到达",
    );

    const { result, unmount } = renderHook(() =>
      useVoiceConversation("voice-asr-before-mount"),
    );

    expect(result.current.turns).toEqual([
      {
        id: "turn-before-mount",
        userText: "订阅之前已经到达",
        assistantText: "",
        awaitingTranscript: false,
      },
    ]);
    unmount();
  });
});

describe("canonical reply-audio delivery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    threadsMock.value = [];
    projectionStoreMock.listener = null;
    audioMock.state.onEnded = null;
    audioMock.playAudioBlob.mockClear();
    audioMock.stopAudio.mockClear();
    captureStartMock.mockClear();
    captureStopMock.mockClear();
    sendMessageMock.mockClear();
    supportsVoiceAdmissionMock.mockReset();
    supportsVoiceAdmissionMock.mockReturnValue(true);
    getActiveBridgeMock.mockReset();
    getActiveBridgeMock.mockReturnValue(undefined);
  });

  it("plays every observed sentence file even when consecutive files reuse a seq", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["audio"]),
      })),
    );
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    const { result, unmount } = renderHook(() =>
      useVoiceConversation("voice-post-terminal-audio"),
    );

    await act(async () => {
      await result.current.start();
    });
    const onUtterance = captureStartMock.mock.calls[0][0] as (
      wav: Blob,
    ) => void;
    await act(async () => {
      onUtterance(new Blob(["question"]));
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(result.current.state).toBe("thinking");

    await act(async () => {
      projectionStoreMock.listener?.(
        "voice-post-terminal-audio\u0000",
        {
          session_id: "voice-post-terminal-audio",
          thread_id: "turn-post-terminal",
          turn_id: "turn-post-terminal",
          seq: 4,
          payload: {
            type: "file_attached",
            data: {
              path: "reply-first.mp3",
              mime: "audio/mpeg",
              size_bytes: 42,
            },
          },
        },
      );
      projectionStoreMock.listener?.(
        "voice-post-terminal-audio\u0000",
        {
          session_id: "voice-post-terminal-audio",
          thread_id: "turn-post-terminal",
          turn_id: "turn-post-terminal",
          seq: 4,
          payload: {
            type: "file_attached",
            data: {
              path: "reply-second.mp3",
              mime: "audio/mpeg",
              size_bytes: 44,
            },
          },
        },
      );
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalledWith(
      "reply-first.mp3?session=voice-post-terminal-audio",
      { headers: {} },
    );
    expect(audioMock.playAudioBlob).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("speaking");

    await act(async () => {
      const finishFirst = audioMock.state.onEnded;
      audioMock.state.onEnded = null;
      finishFirst?.();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalledWith(
      "reply-second.mp3?session=voice-post-terminal-audio",
      { headers: {} },
    );
    expect(audioMock.playAudioBlob).toHaveBeenCalledTimes(2);
    unmount();
  });
});

describe("start() cancellation (post-unmount mic re-acquire)", () => {
  afterEach(() => {
    vi.useRealTimers();
    captureStartMock.mockClear();
    captureStopMock.mockClear();
    sendMessageMock.mockClear();
    admitVoiceMessageMock.mockReset();
    admitVoiceMessageMock.mockResolvedValue({
      status: "speech",
      admissionId: "admission-1",
      transcript: "你好",
    });
    commitAdmittedVoiceMessageMock.mockReset();
    commitAdmittedVoiceMessageMock.mockResolvedValue({ accepted: true });
    interruptActiveTurnMock.mockClear();
    uploadFilesMock.mockReset();
    uploadFilesMock.mockResolvedValue([]);
    cameraMock.active = false;
    cameraMock.start.mockClear();
    cameraMock.start.mockResolvedValue(true);
    cameraMock.grabFrame.mockClear();
    getActiveBridgeMock.mockReset();
    getActiveBridgeMock.mockReturnValue(undefined);
  });

  it("does NOT re-acquire the microphone when the hook unmounts during the bridge-connect wait", async () => {
    vi.useFakeTimers();
    // /voice mints a fresh session per entry, so the bridge is still
    // connecting at mount — start() sits in its ~12s poll.
    getActiveBridgeMock.mockReturnValue(undefined);

    const { result, unmount } = renderHook(() =>
      useVoiceConversation("voice-cancel-test"),
    );

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    // A few poll iterations pass, then the user leaves /voice mid-wait.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    unmount(); // unmount cleanup runs stop()

    // Ride out the rest of the poll + the 12s ceiling. Pre-fix,
    // beginListening() ran here — re-acquiring the mic under a fresh VAD
    // generation that nothing tears down.
    await vi.advanceTimersByTimeAsync(13000);
    await startPromise;

    expect(captureStartMock).not.toHaveBeenCalled();
  });

  it("still begins listening once the bridge connects when start() was not cancelled", async () => {
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });

    const { result, unmount } = renderHook(() =>
      useVoiceConversation("voice-happy-test"),
    );

    await act(async () => {
      await result.current.start();
    });

    expect(captureStartMock).toHaveBeenCalledTimes(1);
    expect(captureStartMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.4,
        minSpeechMs: 300,
        redemptionMs: 700,
      }),
    );
    unmount();
  });

  it("can stop voice capture without turning off an independently enabled camera", () => {
    cameraMock.stop.mockClear();
    const { result, unmount } = renderHook(() =>
      useVoiceConversation("learn-independent-camera-test"),
    );

    act(() => result.current.stop({ preserveCamera: true }));

    expect(captureStopMock).toHaveBeenCalled();
    expect(cameraMock.stop).not.toHaveBeenCalled();
    unmount();
  });

  it("skips the whole turn when ASR admission reports no speech", async () => {
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    uploadFilesMock.mockResolvedValue(["up/utterance.wav"]);
    admitVoiceMessageMock.mockResolvedValueOnce({ status: "no_speech" });
    const onTurnStart = vi.fn();
    const buildTurnText = vi.fn(() => "[[LEARNING_SESSION]] hidden context");

    const { result, unmount } = renderHook(() =>
      useVoiceConversation("learn-no-speech", undefined, undefined, {
        buildTurnText,
        onTurnStart,
        playReplyAudio: false,
      }),
    );

    await act(async () => {
      await result.current.start({
        initialAudio: new Blob(["noise"], { type: "audio/wav" }),
      });
    });

    expect(admitVoiceMessageMock).toHaveBeenCalledTimes(1);
    expect(buildTurnText).not.toHaveBeenCalled();
    expect(onTurnStart).not.toHaveBeenCalled();
    expect(commitAdmittedVoiceMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(result.current.state).toBe("listening");
    unmount();
  });

  it("lets Learn consume admitted speech without starting the outer Agent", async () => {
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    uploadFilesMock.mockResolvedValueOnce(["up/utterance.wav"]);
    admitVoiceMessageMock.mockResolvedValueOnce({
      status: "speech",
      admissionId: "admission-direct",
      transcript: "请解释自然对数",
    });
    const onAdmittedSpeech = vi.fn(async () => true);
    const onTurnStart = vi.fn();

    const { result, unmount } = renderHook(() =>
      useVoiceConversation("learn-direct-voice", undefined, undefined, {
        onAdmittedSpeech,
        onTurnStart,
        playReplyAudio: false,
      }),
    );

    await act(async () => {
      await result.current.start({
        initialAudio: new Blob(["speech"], { type: "audio/wav" }),
      });
    });

    expect(onTurnStart).toHaveBeenCalledOnce();
    expect(onAdmittedSpeech).toHaveBeenCalledWith(expect.objectContaining({
      transcript: "请解释自然对数",
      admissionId: "admission-direct",
      mediaPaths: ["up/utterance.wav"],
      currentFramePath: undefined,
      additionalMediaPaths: [],
    }));
    expect(commitAdmittedVoiceMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(result.current.state).toBe("listening");
    unmount();
  });

  it("does not bypass the external-speech cooldown when Learn handles the turn", async () => {
    vi.useFakeTimers();
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    uploadFilesMock.mockResolvedValueOnce(["up/utterance.wav"]);
    admitVoiceMessageMock.mockResolvedValueOnce({
      status: "speech",
      admissionId: "admission-selection",
      transcript: "解释这个选区",
    });
    let finishHandled!: (handled: boolean) => void;
    const onAdmittedSpeech = vi.fn(() => new Promise<boolean>((resolve) => {
      finishHandled = resolve;
    }));
    const { result, rerender, unmount } = renderHook(
      ({ externalSpeechActive }) =>
        useVoiceConversation("learn-selection-cooldown", undefined, undefined, {
          onAdmittedSpeech,
          playReplyAudio: false,
          externalSpeechActive,
          externalSpeechReleaseDelayMs: 1200,
        }),
      { initialProps: { externalSpeechActive: false } },
    );

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start({
        initialAudio: new Blob(["speech"], { type: "audio/wav" }),
      });
    });
    await vi.waitFor(() => expect(onAdmittedSpeech).toHaveBeenCalledOnce());

    await act(async () => {
      rerender({ externalSpeechActive: true });
      await Promise.resolve();
    });
    await act(async () => {
      rerender({ externalSpeechActive: false });
      await Promise.resolve();
      finishHandled(true);
      await startPromise;
    });

    expect(captureStartMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1199);
    });
    expect(captureStartMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(captureStartMock).toHaveBeenCalledOnce();
    unmount();
  });

  it("reports a failed Agent voice turn without also reporting completion", async () => {
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    uploadFilesMock.mockResolvedValueOnce(["up/utterance.wav"]);
    const onTurnError = vi.fn();
    const onTurnComplete = vi.fn();

    const { result, unmount } = renderHook(() =>
      useVoiceConversation("learn-agent-error", undefined, undefined, {
        onTurnError,
        onTurnComplete,
        playReplyAudio: false,
      }),
    );

    await act(async () => {
      await result.current.start({
        initialAudio: new Blob(["speech"], { type: "audio/wav" }),
      });
    });
    const request = commitAdmittedVoiceMessageMock.mock.calls.at(-1)?.[0];
    const failure = new Error("请求有点多，等几秒再说一遍？");
    act(() => {
      request?.onError?.(failure);
      request?.onComplete?.();
    });

    expect(onTurnError).toHaveBeenCalledWith(expect.any(String), failure);
    expect(onTurnComplete).not.toHaveBeenCalled();
    unmount();
  });

  it("falls back to the legacy voice turn when the server lacks ASR admission", async () => {
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    supportsVoiceAdmissionMock.mockReturnValue(false);
    uploadFilesMock.mockResolvedValue(["up/utterance.wav"]);
    const onTurnStart = vi.fn();
    const buildTurnText = vi.fn(() => "[[LEARNING_SESSION]] legacy context");

    const { result, unmount } = renderHook(() =>
      useVoiceConversation("learn-legacy-voice", undefined, undefined, {
        buildTurnText,
        onTurnStart,
        playReplyAudio: false,
      }),
    );

    await act(async () => {
      await result.current.start({
        initialAudio: new Blob(["speech"], { type: "audio/wav" }),
      });
    });

    expect(admitVoiceMessageMock).not.toHaveBeenCalled();
    expect(commitAdmittedVoiceMessageMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "learn-legacy-voice",
        text: "[[LEARNING_SESSION]] legacy context",
        media: ["up/utterance.wav"],
      }),
    );
    expect(onTurnStart).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("thinking");
    unmount();
  });

  it("waits for the auto-start camera attempt before accepting the first utterance", async () => {
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    let finishCamera!: (ready: boolean) => void;
    cameraMock.start.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        finishCamera = resolve;
      }),
    );
    const { result, unmount } = renderHook(() =>
      useVoiceConversation("learn-camera-ready-test", undefined, undefined, {
        autoStartCamera: true,
      }),
    );

    let startPromise!: Promise<void>;
    act(() => {
      startPromise = result.current.start();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captureStartMock).not.toHaveBeenCalled();

    await act(async () => {
      finishCamera(true);
      await startPromise;
    });
    expect(captureStartMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("submits handed-off wake audio once without a camera frame", async () => {
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    cameraMock.active = true;
    uploadFilesMock.mockResolvedValueOnce(["uploads/wake.wav"]);
    const buildTurnText = vi.fn(() => "[[LEARNING_SESSION]]");
    const onTurnStart = vi.fn();
    const onTurnComplete = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ externalSpeechActive }) =>
        useVoiceConversation("learn-wake-test", undefined, undefined, {
          autoStartCamera: true,
          buildTurnText,
          playReplyAudio: false,
          externalSpeechActive,
          onTurnStart,
          onTurnComplete,
        }),
      { initialProps: { externalSpeechActive: false } },
    );

    await act(async () => {
      await result.current.start({
        initialAudio: new Blob(["wake"], { type: "audio/wav" }),
        includeCamera: false,
      });
    });

    expect(cameraMock.start).toHaveBeenCalledTimes(1);
    expect(cameraMock.grabFrame).not.toHaveBeenCalled();
    expect(onTurnStart).toHaveBeenCalledTimes(1);
    expect(onTurnStart).toHaveBeenCalledWith(expect.any(String));
    expect(onTurnStart.mock.invocationCallOrder[0]).toBeGreaterThan(
      uploadFilesMock.mock.invocationCallOrder[0],
    );
    expect(buildTurnText).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "learn-wake-test",
        currentFramePath: undefined,
      }),
    );
    expect(commitAdmittedVoiceMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "learn-wake-test",
        text: "[[LEARNING_SESSION]]",
        media: ["uploads/wake.wav"],
        liveVideo: false,
      }),
      "admission-1",
      undefined,
    );
    expect(commitAdmittedVoiceMessageMock.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "suppressReplyAudio",
    );
    const complete = commitAdmittedVoiceMessageMock.mock.calls.at(-1)?.[0]
      ?.onComplete as
      | (() => void)
      | undefined;
    await act(async () => {
      rerender({ externalSpeechActive: true });
      await Promise.resolve();
    });
    await act(async () => {
      complete?.();
      await Promise.resolve();
    });
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(captureStartMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      rerender({ externalSpeechActive: false });
      await Promise.resolve();
    });
    expect(captureStartMock).toHaveBeenCalledTimes(2);
    audioMock.stopAudio.mockClear();
    act(() => result.current.stop());
    expect(audioMock.stopAudio).not.toHaveBeenCalled();
    unmount();
  });

  it("waits for external speaker echo to drain before resuming capture", async () => {
    vi.useFakeTimers();
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    const { result, rerender, unmount } = renderHook(
      ({ externalSpeechActive }) =>
        useVoiceConversation("learn-speaker-tail-test", undefined, undefined, {
          playReplyAudio: false,
          externalSpeechActive,
          externalSpeechReleaseDelayMs: 1200,
        }),
      { initialProps: { externalSpeechActive: false } },
    );

    await act(async () => {
      await result.current.start();
    });
    expect(captureStartMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender({ externalSpeechActive: true });
      await Promise.resolve();
    });
    expect(captureStopMock).toHaveBeenCalled();

    await act(async () => {
      rerender({ externalSpeechActive: false });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1199);
    });
    expect(captureStartMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(captureStartMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("keeps application attachments distinct from audio and the live camera frame", async () => {
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    const selection = new File(["selection"], "selection.png", {
      type: "image/png",
    });
    const getAdditionalTurnFiles = vi.fn(async () => [selection]);
    uploadFilesMock.mockResolvedValueOnce([
      "uploads/utterance.wav",
      "uploads/selection.png",
    ]);
    const buildTurnText = vi.fn((context: VoiceTurnSendContext) =>
      context.additionalMediaPaths?.join(",") ?? "",
    );
    const { result, unmount } = renderHook(() =>
      useVoiceConversation("learn-selection-voice-test", undefined, undefined, {
        getAdditionalTurnFiles,
        buildTurnText,
        playReplyAudio: false,
      }),
    );

    await act(async () => {
      await result.current.start({
        initialAudio: new Blob(["voice"], { type: "audio/wav" }),
        includeCamera: false,
      });
    });

    expect(getAdditionalTurnFiles).toHaveBeenCalledOnce();
    expect(buildTurnText).toHaveBeenCalledWith(expect.objectContaining({
      currentFramePath: undefined,
      mediaPaths: ["uploads/utterance.wav", "uploads/selection.png"],
      additionalMediaPaths: ["uploads/selection.png"],
    }));
    expect(commitAdmittedVoiceMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "uploads/selection.png",
        media: ["uploads/utterance.wav", "uploads/selection.png"],
        liveVideo: false,
      }),
      "admission-1",
      undefined,
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    unmount();
  });
});

describe("interrupt() supersedes the drain loop (stale grace timer)", () => {
  // codex P2 on the playback-interrupt fix: resolving the interrupted clip's
  // promise lets the old drainQueue() continuation run to completion — it
  // must NOT then schedule its return-to-listening grace timer, because
  // interrupt() already chose the next state. Pre-fix the stale timer could
  // fire ~1.5s later, see the user's follow-up turn in `thinking`, and knock
  // it back to `listening` (disrupting the in-flight turn).
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    threadsMock.value = [];
    audioMock.state.onEnded = null;
    audioMock.playAudioBlob.mockClear();
    audioMock.stopAudio.mockClear();
    captureStartMock.mockClear();
    captureStopMock.mockClear();
    getActiveBridgeMock.mockReset();
    getActiveBridgeMock.mockReturnValue(undefined);
  });

  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it("a stale post-interrupt grace timer must not knock the next turn back to listening", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["a"]),
      })),
    );
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });

    const { result, rerender } = renderHook(() =>
      useVoiceConversation("voice-interrupt-test"),
    );

    // Enter listening (bridge already connected → no poll wait).
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.state).toBe("listening");

    // First utterance → thinking.
    const onUtterance1 = captureStartMock.mock.calls[0][0] as (
      wav: Blob,
    ) => void;
    await act(async () => {
      onUtterance1(new Blob(["u1"]));
      await flushMicrotasks();
    });
    expect(result.current.state).toBe("thinking");

    // Reply audio lands → the drain loop starts playing it (the mock parks
    // the clip's completion callback, i.e. playback is in flight).
    threadsMock.value = [
      {
        id: "turn-1",
        userMsg: { text: "hi" },
        pendingAssistant: null,
        responses: [
          { role: "assistant", text: "reply", files: [{ path: "w/r1.wav" }] },
        ],
      },
    ];
    rerender();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(result.current.state).toBe("speaking");

    // User taps the orb mid-playback: discard the clip, back to listening.
    const listenCallsBeforeInterrupt = captureStartMock.mock.calls.length;
    await act(async () => {
      result.current.interrupt();
      await flushMicrotasks();
    });
    expect(result.current.state).toBe("listening");

    // The user immediately speaks again — the follow-up turn is `thinking`
    // well inside the superseded drain's 1.5s grace window.
    const onUtterance2 = captureStartMock.mock.calls[
      listenCallsBeforeInterrupt
    ][0] as (wav: Blob) => void;
    await act(async () => {
      onUtterance2(new Blob(["u2"]));
      await flushMicrotasks();
    });
    expect(result.current.state).toBe("thinking");

    // Ride past the grace window: the stale timer must not fire
    // beginListening() against the in-flight turn.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.state).toBe("thinking");
  });

  it("lets the user interrupt reply audio by speaking", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["a"]),
      })),
    );
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });

    const { result, rerender } = renderHook(() =>
      useVoiceConversation("voice-barge-in-test"),
    );
    const sendCountBefore = commitAdmittedVoiceMessageMock.mock.calls.length;

    await act(async () => {
      await result.current.start();
    });

    const firstListeningUtterance = captureStartMock.mock.calls[0][0] as (
      wav: Blob,
    ) => void;
    await act(async () => {
      firstListeningUtterance(new Blob(["u1"]));
      await flushMicrotasks();
    });
    expect(result.current.state).toBe("thinking");
    expect(commitAdmittedVoiceMessageMock).toHaveBeenCalledTimes(sendCountBefore + 1);

    threadsMock.value = [
      {
        id: "turn-1",
        userMsg: { text: "hi" },
        pendingAssistant: null,
        responses: [
          { role: "assistant", text: "reply", files: [{ path: "w/r1.wav" }] },
        ],
      },
    ];
    rerender();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(result.current.state).toBe("speaking");

    const bargeInCall = captureStartMock.mock.calls.at(-1)!;
    const bargeInOptions = bargeInCall[1] as {
      positiveSpeechThreshold: number;
      minSpeechMs: number;
      onSpeechConfirmed: () => void;
      onVADMisfire: () => void;
    };
    const bargeInUtterance = bargeInCall[0] as (wav: Blob) => void;
    expect(bargeInOptions.positiveSpeechThreshold).toBe(0.68);
    expect(bargeInOptions.minSpeechMs).toBe(620);

    await act(async () => {
      bargeInOptions.onVADMisfire();
      await flushMicrotasks();
    });
    expect(audioMock.stopAudio).not.toHaveBeenCalled();
    expect(commitAdmittedVoiceMessageMock).toHaveBeenCalledTimes(sendCountBefore + 1);
    expect(result.current.state).toBe("speaking");

    await act(async () => {
      bargeInOptions.onSpeechConfirmed();
      await flushMicrotasks();
    });
    expect(audioMock.stopAudio).toHaveBeenCalled();

    await act(async () => {
      bargeInUtterance(new Blob(["u2"]));
      await flushMicrotasks();
    });

    expect(commitAdmittedVoiceMessageMock).toHaveBeenCalledTimes(sendCountBefore + 2);
    expect(
      commitAdmittedVoiceMessageMock.mock.calls.at(-1)?.[2],
    ).toEqual(expect.any(String));
    expect(result.current.state).toBe("thinking");
  });

  it("stops an old reply that begins playing while thinking barge-in awaits admission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["a"]),
      })),
    );
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    uploadFilesMock.mockResolvedValue(["up/utterance.wav"]);
    let resolveBargeInAdmission!: (value: {
      status: "speech";
      admissionId: string;
      transcript: string;
    }) => void;
    admitVoiceMessageMock
      .mockResolvedValueOnce({
        status: "speech",
        admissionId: "first-admission",
        transcript: "第一句",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveBargeInAdmission = resolve;
          }),
      );
    audioMock.playAudioBlob.mockClear();
    audioMock.stopAudio.mockClear();

    const { result, rerender } = renderHook(() =>
      useVoiceConversation("voice-thinking-barge-in-race"),
    );
    await act(async () => {
      await result.current.start();
    });

    const firstUtterance = captureStartMock.mock.calls[0][0] as (
      wav: Blob,
    ) => void;
    await act(async () => {
      firstUtterance(new Blob(["u1"]));
      await flushMicrotasks();
    });
    expect(result.current.state).toBe("thinking");

    const thinkingBargeInCall = captureStartMock.mock.calls.at(-1)!;
    const thinkingBargeInOptions = thinkingBargeInCall[1] as {
      onSpeechConfirmed: () => void;
    };
    const thinkingBargeInUtterance = thinkingBargeInCall[0] as (
      wav: Blob,
    ) => void;
    await act(async () => {
      thinkingBargeInOptions.onSpeechConfirmed();
      thinkingBargeInUtterance(new Blob(["u2"]));
      await flushMicrotasks();
    });

    // The old turn publishes its first sentence while the second utterance is
    // still waiting for ASR admission.
    threadsMock.value = [
      {
        id: "turn-old-thinking",
        userMsg: { text: "hi" },
        pendingAssistant: null,
        responses: [
          {
            role: "assistant",
            text: "old reply",
            files: [{ path: "w/late-old.wav" }],
          },
        ],
      },
    ];
    rerender();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(audioMock.playAudioBlob).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("speaking");

    await act(async () => {
      resolveBargeInAdmission({
        status: "speech",
        admissionId: "barge-in-admission",
        transcript: "第二句",
      });
      await flushMicrotasks();
    });

    expect(audioMock.stopAudio).toHaveBeenCalledTimes(1);
    expect(commitAdmittedVoiceMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: expect.any(String) }),
      "barge-in-admission",
      expect.any(String),
    );
    expect(result.current.state).toBe("thinking");
  });

  it("restarts the paused sentence and keeps the old turn when barge-in is no speech", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["a"]),
      })),
    );
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });
    admitVoiceMessageMock
      .mockResolvedValueOnce({
        status: "speech",
        admissionId: "first-admission",
        transcript: "第一句",
      })
      .mockResolvedValueOnce({ status: "no_speech" });

    const { result, rerender } = renderHook(() =>
      useVoiceConversation("voice-barge-in-no-speech"),
    );
    await act(async () => {
      await result.current.start();
    });
    const firstUtterance = captureStartMock.mock.calls[0][0] as (
      wav: Blob,
    ) => void;
    await act(async () => {
      firstUtterance(new Blob(["u1"]));
      await flushMicrotasks();
    });
    threadsMock.value = [
      {
        id: "turn-old",
        userMsg: { text: "hi" },
        pendingAssistant: null,
        responses: [
          { role: "assistant", text: "reply", files: [{ path: "w/old.wav" }] },
        ],
      },
    ];
    rerender();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(result.current.state).toBe("speaking");
    expect(audioMock.playAudioBlob).toHaveBeenCalledTimes(1);

    const bargeInCall = captureStartMock.mock.calls.at(-1)!;
    const options = bargeInCall[1] as { onSpeechConfirmed: () => void };
    const utterance = bargeInCall[0] as (wav: Blob) => void;
    const commitsBefore = commitAdmittedVoiceMessageMock.mock.calls.length;
    await act(async () => {
      options.onSpeechConfirmed();
      utterance(new Blob(["friction"]));
      await flushMicrotasks();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushMicrotasks();
    });

    expect(commitAdmittedVoiceMessageMock).toHaveBeenCalledTimes(commitsBefore);
    expect(interruptActiveTurnMock).not.toHaveBeenCalled();
    expect(audioMock.playAudioBlob).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("speaking");
  });

  it("keeps one speaking VAD active across multiple reply audio clips", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob(["a"]),
      })),
    );
    getActiveBridgeMock.mockReturnValue({
      getConnectionState: () => "connected",
    });

    const { result, rerender, unmount } = renderHook(() =>
      useVoiceConversation("voice-continuous-vad-test"),
    );

    await act(async () => {
      await result.current.start();
    });
    const firstListeningUtterance = captureStartMock.mock.calls[0][0] as (
      wav: Blob,
    ) => void;
    await act(async () => {
      firstListeningUtterance(new Blob(["u1"]));
      await flushMicrotasks();
    });

    threadsMock.value = [
      {
        id: "turn-multi",
        userMsg: { text: "tell me a long story" },
        pendingAssistant: null,
        responses: [
          {
            role: "assistant",
            text: "part one. part two.",
            files: [{ path: "w/r1.wav" }, { path: "w/r2.wav" }],
          },
        ],
      },
    ];
    rerender();
    await act(async () => {
      await flushMicrotasks();
    });

    expect(result.current.state).toBe("speaking");
    const startsAfterFirstClip = captureStartMock.mock.calls.length;
    expect(audioMock.playAudioBlob).toHaveBeenCalledTimes(1);

    await act(async () => {
      const finishFirstClip = audioMock.state.onEnded;
      audioMock.state.onEnded = null;
      finishFirstClip?.();
      await flushMicrotasks();
    });

    expect(audioMock.playAudioBlob).toHaveBeenCalledTimes(2);
    expect(captureStartMock).toHaveBeenCalledTimes(startsAfterFirstClip);
    unmount();
  });
});

describe("shouldHandleNoSpeechEvent", () => {
  it("matches the active voice turn in the same session/topic", () => {
    expect(
      shouldHandleNoSpeechEvent(
        {
          sessionId: "s1",
          topic: "voice",
          threadId: "turn-1",
        },
        "s1",
        "voice",
        "turn-1",
      ),
    ).toBe(true);
    expect(
      shouldHandleNoSpeechEvent(
        {
          sessionId: "s1",
          topic: "voice",
          threadId: "turn-2",
        },
        "s1",
        "voice",
        "turn-1",
      ),
    ).toBe(false);
  });
});
