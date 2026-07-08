import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceCapture } from "./use-voice-capture";

const { vadNewMock, vadInstances } = vi.hoisted(() => ({
  vadNewMock: vi.fn(),
  vadInstances: [] as Array<{
    options: Record<string, unknown>;
    start: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
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
      };
      vadInstances.push(vad);
      return vad;
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));
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
