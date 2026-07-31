import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOllNarrationTts } from "./use-oll-narration-tts";

class FakeUtterance {
  text: string;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

describe("useOllNarrationTts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("OLL-TCH-002 speaks the active narration in text mode", () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", { speak, cancel });

    const { rerender, unmount } = renderHook(
      (props) => useOllNarrationTts(props),
      {
        initialProps: {
          enabled: true,
          playing: true,
          text: "先从三出发。",
          language: "zh-CN",
        },
      },
    );

    expect(speak).toHaveBeenCalledTimes(1);
    const utterance = speak.mock.calls[0]![0] as FakeUtterance;
    expect(utterance.text).toBe("先从三出发。");
    expect(utterance.lang).toBe("zh-CN");

    rerender({
      enabled: true,
      playing: true,
      text: "",
      language: "zh-CN",
    });
    expect(cancel).toHaveBeenCalled();
    unmount();
  });

  it("R-007 keeps narration playback independent when synthesis fails", () => {
    const speak = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn() });

    const { result } = renderHook(() =>
      useOllNarrationTts({
        enabled: true,
        playing: true,
        text: "旁白仍然可见。",
        language: "zh-CN",
      }),
    );
    const utterance = speak.mock.calls[0]![0] as FakeUtterance;
    act(() => utterance.onerror?.());
    expect(result.current.error).toBe(
      "课程语音暂时不可用，旁白仍会显示。",
    );
  });

  it("does not speak while disabled or paused", () => {
    const speak = vi.fn();
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", { speak, cancel: vi.fn() });

    renderHook(() =>
      useOllNarrationTts({
        enabled: false,
        playing: true,
        text: "不应朗读。",
        language: "zh-CN",
      }),
    );
    expect(speak).not.toHaveBeenCalled();
  });
});
