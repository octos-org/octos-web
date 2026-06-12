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
});
