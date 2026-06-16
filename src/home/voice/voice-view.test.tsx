import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceView } from "./voice-view";
import type { VoiceConversation } from "./use-voice-conversation";

const conversationMock = vi.hoisted(() => ({
  state: "idle" as VoiceConversation["state"],
  cameraActive: false,
  start: vi.fn(),
  stop: vi.fn(),
  interrupt: vi.fn(),
  toggleCamera: vi.fn(),
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
    cameraActive: conversationMock.cameraActive,
    cameraError: null,
    toggleCamera: conversationMock.toggleCamera,
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
    conversationMock.cameraActive = false;
    conversationMock.start.mockReset();
    conversationMock.stop.mockReset();
    conversationMock.interrupt.mockReset();
    conversationMock.toggleCamera.mockReset();
  });

  it("waits for an orb click before starting microphone capture", () => {
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(conversationMock.start).not.toHaveBeenCalled();
    expect(screen.getByText("点光球开始说话")).toBeTruthy();
    expect(screen.queryByTestId("voice-selector")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "voice orb" }));

    expect(conversationMock.start).toHaveBeenCalledTimes(1);
  });

  it("toggles the camera when the camera button is clicked", () => {
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "toggle camera" }));

    expect(conversationMock.toggleCamera).toHaveBeenCalledTimes(1);
  });

  it("shows the camera status indicator only when the camera is active", () => {
    conversationMock.cameraActive = true;
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(screen.getByText("摄像头开启中")).toBeTruthy();
  });
});
