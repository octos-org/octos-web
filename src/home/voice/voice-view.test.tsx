import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceView } from "./voice-view";
import type { VoiceConversation } from "./use-voice-conversation";

const conversationMock = vi.hoisted(() => ({
  state: "idle" as VoiceConversation["state"],
  start: vi.fn(),
  stop: vi.fn(),
  interrupt: vi.fn(),
}));

vi.mock("./use-voice-conversation", () => ({
  useVoiceConversation: () => ({
    state: conversationMock.state,
    lastUserText: "",
    lastAssistantText: "",
    error: null,
    start: conversationMock.start,
    stop: conversationMock.stop,
    interrupt: conversationMock.interrupt,
  }),
}));

vi.mock("./voice-orb", () => ({
  VoiceOrb: ({ state }: { state: string }) => (
    <div data-testid="voice-orb-state">{state}</div>
  ),
}));

vi.mock("./voice-selector", () => ({
  VoiceSelector: () => <div data-testid="voice-selector" />,
}));

vi.mock("./audio-playback", () => ({
  unlockAudio: vi.fn(),
}));

describe("VoiceView", () => {
  beforeEach(() => {
    cleanup();
    conversationMock.state = "idle";
    conversationMock.start.mockReset();
    conversationMock.stop.mockReset();
    conversationMock.interrupt.mockReset();
  });

  it("waits for an orb click before starting microphone capture", () => {
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(conversationMock.start).not.toHaveBeenCalled();
    expect(screen.getByText("点光球开始说话")).toBeTruthy();
    expect(screen.queryByTestId("voice-selector")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "voice orb" }));

    expect(conversationMock.start).toHaveBeenCalledTimes(1);
  });
});
