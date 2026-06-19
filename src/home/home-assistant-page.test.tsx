import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAssistantPage } from "./home-assistant-page";

const navigateMock = vi.hoisted(() => vi.fn());
const loadHistoryMock = vi.hoisted(() => vi.fn());
const unlockAudioMock = vi.hoisted(() => vi.fn());
const runtimeMock = vi.hoisted(() => ({
  ready: true,
  loading: false,
  label: "Voice engine ready",
  tone: "success" as const,
}));
const wakeMock = vi.hoisted(() => ({
  options: null as null | {
    enabled: boolean;
    onDetected: (detection: {
      at: number;
      score: number;
      wakeWord: string;
    }) => void;
  },
  state: "listening",
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
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

vi.mock("@/components/ui-protocol-approval-host", () => ({
  UiProtocolApprovalHost: () => null,
}));

vi.mock("@/store/thread-store", () => ({
  loadHistory: (...args: unknown[]) => loadHistoryMock(...args),
}));

vi.mock("./use-wake-lock", () => ({
  useWakeLock: vi.fn(),
}));

vi.mock("./home-settings-context", () => ({
  HomeSettingsProvider: ({ children }: { children: ReactNode }) => children,
  useHomeSettings: () => ({ nightMode: "off" }),
}));

vi.mock("./use-clock", () => ({
  useClock: () => ({ date: new Date("2026-06-19T12:00:00") }),
}));

vi.mock("./bilibili-music", () => ({
  BILIBILI_MUSIC_SCENES: [{ id: "cooking-dinner" }],
  createBilibiliMusicController: () => ({
    getSnapshot: () => ({ playing: false }),
    playScene: vi.fn(async () => undefined),
    stop: vi.fn(),
  }),
}));

vi.mock("./standby-view", () => ({
  StandbyView: ({
    wakeWordStatus,
  }: {
    wakeWordStatus?: { label: string };
  }) => (
    <div>
      <span data-testid="wake-word-status">
        {wakeWordStatus?.label ?? "none"}
      </span>
    </div>
  ),
}));

vi.mock("./conversation-view", () => ({
  ConversationView: () => <div data-testid="conversation-view" />,
}));

vi.mock("./use-ominix-runtime-summary", () => ({
  useOminixRuntimeSummary: () => runtimeMock,
}));

vi.mock("./voice/audio-playback", () => ({
  unlockAudio: () => unlockAudioMock(),
}));

vi.mock("./voice/use-wake-word-listener", () => ({
  describeWakeWordListener: (state: string, wakeWord: string) => ({
    label: `${state}:${wakeWord}`,
    tone: "success",
  }),
  useWakeWordListener: (options: {
    enabled: boolean;
    onDetected: (detection: {
      at: number;
      score: number;
      wakeWord: string;
    }) => void;
  }) => {
    wakeMock.options = options;
    return {
      state: wakeMock.state,
      score: 0.7,
      error: null,
      wakeWord: "你好小章鱼",
      supported: true,
      start: vi.fn(),
      stop: vi.fn(),
    };
  },
}));

describe("HomeAssistantPage wake word", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    navigateMock.mockReset();
    loadHistoryMock.mockReset();
    unlockAudioMock.mockReset();
    runtimeMock.ready = true;
    runtimeMock.loading = false;
    runtimeMock.label = "Voice engine ready";
    runtimeMock.tone = "success";
    wakeMock.options = null;
    wakeMock.state = "listening";
  });

  it("starts the wake listener on standby and opens voice on detection", () => {
    render(<HomeAssistantPage />);

    expect(wakeMock.options?.enabled).toBe(true);
    expect(screen.getByTestId("wake-word-status").textContent).toBe(
      "listening:你好小章鱼",
    );

    act(() => {
      wakeMock.options?.onDetected({
        at: Date.now(),
        score: 0.8,
        wakeWord: "你好小章鱼",
      });
    });

    expect(unlockAudioMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/voice");
  });

  it("does not expose a wake status when the voice runtime is not ready", () => {
    runtimeMock.ready = false;

    render(<HomeAssistantPage />);

    expect(wakeMock.options?.enabled).toBe(false);
    expect(screen.getByTestId("wake-word-status").textContent).toBe("none");
  });
});
