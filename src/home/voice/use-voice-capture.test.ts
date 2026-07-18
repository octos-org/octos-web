import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceCapture } from "./use-voice-capture";

const { getUserMediaMock, vadNewMock, vadInstances } = vi.hoisted(() => ({
  getUserMediaMock: vi.fn(),
  vadNewMock: vi.fn(),
  vadInstances: [] as Array<{
    options: Record<string, unknown>;
    start: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    setOptions: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@ricky0123/vad-web", () => ({
  MicVAD: {
    new: vadNewMock,
  },
}));

describe("useVoiceCapture", () => {
  beforeEach(() => {
    vadInstances.length = 0;
    vadNewMock.mockReset();
    vadNewMock.mockImplementation(async (options: Record<string, unknown>) => {
      const vad = {
        options,
        start: vi.fn(async () => {}),
        pause: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        setOptions: vi.fn(),
      };
      vadInstances.push(vad);
      return vad;
    });
    getUserMediaMock.mockReset();
    getUserMediaMock.mockResolvedValue({} as MediaStream);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: getUserMediaMock },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));
  });

  it("requests all-system echo cancellation for initial and resumed capture", async () => {
    const initialStream = {} as MediaStream;
    const resumedStream = {} as MediaStream;
    getUserMediaMock
      .mockResolvedValueOnce(initialStream)
      .mockResolvedValueOnce(resumedStream);
    const { result, unmount } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.start(vi.fn());
    });

    const options = vadInstances[0].options as {
      getStream: () => Promise<MediaStream>;
      resumeStream: (stream: MediaStream) => Promise<MediaStream>;
    };
    await expect(options.getStream()).resolves.toBe(initialStream);
    await expect(options.resumeStream(initialStream)).resolves.toBe(resumedStream);
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    for (const call of getUserMediaMock.mock.calls) {
      expect(call[0]).toEqual({
        audio: {
          channelCount: 1,
          echoCancellation: "all",
          autoGainControl: true,
          noiseSuppression: true,
        },
      });
    }
    unmount();
  });

  it("always passes a callable onSpeechRealStart to MicVAD", async () => {
    const { result, unmount } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.start(vi.fn());
    });

    expect(typeof vadInstances[0].options.onSpeechRealStart).toBe("function");
    expect(() => {
      (vadInstances[0].options.onSpeechRealStart as () => void)();
    }).not.toThrow();
    unmount();
  });

  it("surfaces confirmed speech and VAD misfires separately", async () => {
    const onSpeechStart = vi.fn();
    const onSpeechConfirmed = vi.fn();
    const onVADMisfire = vi.fn();
    const { result, unmount } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.start(vi.fn(), {
        onSpeechStart,
        onSpeechConfirmed,
        onVADMisfire,
      });
    });

    await act(async () => {
      (vadInstances[0].options.onSpeechStart as () => void)();
      (vadInstances[0].options.onVADMisfire as () => void)();
      (vadInstances[0].options.onSpeechRealStart as () => void)();
      await Promise.resolve();
    });

    expect(onSpeechStart).toHaveBeenCalledTimes(1);
    expect(onVADMisfire).toHaveBeenCalledTimes(1);
    expect(onSpeechConfirmed).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("reuses the active VAD and updates callbacks and thresholds", async () => {
    const firstUtterance = vi.fn();
    const secondUtterance = vi.fn();
    const firstConfirmed = vi.fn();
    const secondConfirmed = vi.fn();
    const { result, unmount } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.start(firstUtterance, {
        positiveSpeechThreshold: 0.75,
        minSpeechMs: 700,
        onSpeechConfirmed: firstConfirmed,
      });
      await result.current.start(secondUtterance, {
        positiveSpeechThreshold: 0.68,
        minSpeechMs: 620,
        onSpeechConfirmed: secondConfirmed,
      });
    });

    expect(vadNewMock).toHaveBeenCalledTimes(1);
    expect(vadInstances[0].pause).not.toHaveBeenCalled();
    expect(vadInstances[0].destroy).not.toHaveBeenCalled();
    expect(vadInstances[0].setOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        positiveSpeechThreshold: 0.68,
        minSpeechMs: 620,
      }),
    );

    await act(async () => {
      (vadInstances[0].options.onSpeechRealStart as () => void)();
      (vadInstances[0].options.onSpeechEnd as (audio: Float32Array) => void)(
        new Float32Array([0.1, 0.2]),
      );
      await Promise.resolve();
    });

    expect(firstConfirmed).not.toHaveBeenCalled();
    expect(secondConfirmed).toHaveBeenCalledTimes(1);
    expect(firstUtterance).not.toHaveBeenCalled();
    expect(secondUtterance).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("shares one initialization when capture mode changes before VAD is ready", async () => {
    let releaseInitialization!: () => void;
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    vadNewMock.mockReset();
    vadNewMock.mockImplementation(async (options: Record<string, unknown>) => {
      await initializationGate;
      const vad = {
        options,
        start: vi.fn(async () => {}),
        pause: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        setOptions: vi.fn(),
      };
      vadInstances.push(vad);
      return vad;
    });

    const thinkingConfirmed = vi.fn();
    const speakingConfirmed = vi.fn();
    const { result, unmount } = renderHook(() => useVoiceCapture());

    let thinkingStart!: Promise<void>;
    let speakingStart!: Promise<void>;
    await act(async () => {
      thinkingStart = result.current.start(vi.fn(), {
        positiveSpeechThreshold: 0.75,
        onSpeechConfirmed: thinkingConfirmed,
      });
      await Promise.resolve();
      speakingStart = result.current.start(vi.fn(), {
        positiveSpeechThreshold: 0.68,
        onSpeechConfirmed: speakingConfirmed,
      });
      releaseInitialization();
      await Promise.all([thinkingStart, speakingStart]);
    });

    expect(vadNewMock).toHaveBeenCalledTimes(1);
    expect(vadInstances[0].setOptions).toHaveBeenCalledWith(
      expect.objectContaining({ positiveSpeechThreshold: 0.68 }),
    );
    await act(async () => {
      (vadInstances[0].options.onSpeechRealStart as () => void)();
      await Promise.resolve();
    });
    expect(thinkingConfirmed).not.toHaveBeenCalled();
    expect(speakingConfirmed).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not reacquire the microphone after stop wins a teardown race", async () => {
    let releasePause!: () => void;
    const pauseGate = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const { result, unmount } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.start(vi.fn());
    });
    vadInstances[0].pause.mockImplementationOnce(async () => pauseGate);

    let firstStop!: Promise<void>;
    let restart!: Promise<void>;
    let finalStop!: Promise<void>;
    await act(async () => {
      firstStop = result.current.stop();
      restart = result.current.start(vi.fn());
      await Promise.resolve();
      finalStop = result.current.stop();
      releasePause();
      await Promise.all([firstStop, restart, finalStop]);
    });

    expect(vadNewMock).toHaveBeenCalledTimes(1);
    expect(vadInstances[0].destroy).toHaveBeenCalledTimes(1);
    expect(result.current.capturing).toBe(false);
    unmount();
  });

  it("ignores stale VAD callbacks after stop", async () => {
    const onUtterance = vi.fn();
    const { result, unmount } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.start(onUtterance);
    });
    await act(async () => {
      result.current.stop();
    });

    (vadInstances[0].options.onSpeechEnd as (audio: Float32Array) => void)(
      new Float32Array([0.1, 0.2]),
    );

    expect(onUtterance).not.toHaveBeenCalled();
    unmount();
  });

  it("falls back to V5 when the preferred model fails to start", async () => {
    const err = new Error("legacy not supported");
    vadNewMock.mockReset();
    vadNewMock.mockImplementation(async (options: Record<string, unknown>) => {
      const vad = {
        options,
        start:
          options.model === "legacy"
            ? vi.fn(async () => {
                throw err;
              })
            : vi.fn(async () => {}),
        pause: vi.fn(async () => {}),
        destroy: vi.fn(async () => {}),
        setOptions: vi.fn(),
      };
      vadInstances.push(vad);
      return vad;
    });

    const { result, unmount } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.start(vi.fn());
    });

    expect(vadNewMock).toHaveBeenCalledTimes(2);
    expect(vadInstances[0].options.model).toBe("legacy");
    expect(vadInstances[1].options.model).toBe("v5");
    expect(result.current.capturing).toBe(true);
    expect(result.current.error).toBeNull();
    expect(vadInstances[1].start).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("captures VAD callback errors into hook error state", async () => {
    const { result, unmount } = renderHook(() => useVoiceCapture());

    await act(async () => {
      await result.current.start(vi.fn(), {
        onSpeechRealStart: () => {
          throw new Error("wake callback boom");
        },
      });
    });

    await act(async () => {
      (vadInstances[0].options.onSpeechRealStart as () => void)();
      await Promise.resolve();
    });

    expect(result.current.error).toBe("wake callback boom");
    unmount();
  });

});
