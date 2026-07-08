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
} from "./use-voice-conversation";
import type { Thread } from "@/store/thread-store";

// ---------------------------------------------------------------------------
// Hook-level harness (start() cancellation — post-unmount mic re-acquire).
// The pure-function suites below don't touch these mocks.
// ---------------------------------------------------------------------------

const {
  captureStartMock,
  captureStopMock,
  getActiveBridgeMock,
  sendMessageMock,
} = vi.hoisted(() => ({
  captureStartMock: vi.fn(async () => {}),
  captureStopMock: vi.fn(async () => {}),
  getActiveBridgeMock: vi.fn((): unknown => undefined),
  sendMessageMock: vi.fn(),
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
  start: vi.fn(async () => {}),
  stop: vi.fn(),
  grabFrame: vi.fn(async () => null),
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

vi.mock("@/store/thread-store", () => ({
  useThreads: () => threadsMock.value,
}));

vi.mock("@/runtime/ui-protocol-send", () => ({
  interruptActiveTurn: vi.fn(async () => true),
  sendMessage: sendMessageMock,
}));

vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: getActiveBridgeMock,
}));

vi.mock("@/api/chat", () => ({
  uploadFiles: vi.fn(async () => []),
}));

vi.mock("@/api/files", () => ({
  buildFileUrl: (p: string) => p,
}));

vi.mock("@/api/client", () => ({
  buildApiHeaders: () => ({}),
}));

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

describe("start() cancellation (post-unmount mic re-acquire)", () => {
  afterEach(() => {
    vi.useRealTimers();
    captureStartMock.mockClear();
    captureStopMock.mockClear();
    sendMessageMock.mockClear();
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
    const sendCountBefore = sendMessageMock.mock.calls.length;

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
    expect(sendMessageMock).toHaveBeenCalledTimes(sendCountBefore + 1);

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
    expect(sendMessageMock).toHaveBeenCalledTimes(sendCountBefore + 1);
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

    expect(sendMessageMock).toHaveBeenCalledTimes(sendCountBefore + 2);
    expect(result.current.state).toBe("thinking");
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
