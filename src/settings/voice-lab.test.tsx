import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceLab } from "./voice-lab";

const { captureStart, captureStop, sendMessage } = vi.hoisted(() => ({
  captureStart: vi.fn(),
  captureStop: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@/home/voice/use-voice-capture", () => ({
  getVoiceCaptureDiagnosticConfig: () => ({
    requestedConstraints: {
      channelCount: 1,
      echoCancellation: "all",
      autoGainControl: true,
      noiseSuppression: true,
    },
    sampleRate: 16000,
    modelPreference: ["legacy", "v5"],
    defaults: {
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionMs: 700,
      preSpeechPadMs: 800,
      submitUserSpeechOnPause: false,
    },
  }),
  useVoiceCapture: () => ({
    capturing: false,
    start: captureStart,
    stop: captureStop,
    error: null,
  }),
}));

vi.mock("@/home/voice/vad-config", () => ({
  LISTENING_VAD_OPTIONS: {
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    minSpeechMs: 220,
    redemptionMs: 700,
  },
}));

// The Lab must not import or call the production turn bridge. Keeping this
// explicit guards against accidentally wiring a diagnostic recording to a turn.
vi.mock("@/runtime/ui-protocol-send", () => ({ sendMessage }));

describe("VoiceLab", () => {
  beforeEach(() => {
    captureStart.mockReset();
    captureStop.mockReset();
    sendMessage.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:voice-lab") as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn();
  });

  it("records through the shared capture hook without starting a production turn", async () => {
    render(<VoiceLab />);

    fireEvent.click(screen.getByRole("button", { name: /start microphone diagnostic/i }));

    expect(captureStart).toHaveBeenCalledTimes(1);
    expect(captureStart.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        onSpeechStart: expect.any(Function),
        onSpeechConfirmed: expect.any(Function),
        onFrameProcessed: expect.any(Function),
        positiveSpeechThreshold: 0.5,
        minSpeechMs: 220,
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      captureStart.mock.calls[0][0](new Blob([new Uint8Array(32044)], {
        type: "audio/wav",
      }));
    });

    expect(screen.getByText(/recorded candidate/i)).toBeTruthy();
    expect(screen.getByText(/1\.00 s/)).toBeTruthy();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
