import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { VoicePage } from "./voice-page";

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/runtime/runtime-provider", () => ({
  ScopedRuntimeBridge: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/runtime/session-context", () => ({
  SessionContext: {
    Provider: ({ children }: { children: React.ReactNode }) => children,
  },
  useModeState: () => ({ queueMode: null, adaptiveMode: null }),
}));

vi.mock("@/components/ui-protocol-question-host", () => ({
  UiProtocolQuestionHost: () => null,
}));

vi.mock("./voice-view", () => ({
  VoiceView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="voice-session-id">{sessionId}</div>
  ),
}));

describe("VoicePage", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("creates a fresh voice session every time the route mounts", () => {
    localStorage.setItem("octos_voice_session_id", "voice-stale");

    const first = render(<VoicePage />);
    const firstSessionId = screen.getByTestId("voice-session-id").textContent;
    first.unmount();

    render(<VoicePage />);
    const secondSessionId = screen.getByTestId("voice-session-id").textContent;

    expect(firstSessionId).toMatch(/^voice-/);
    expect(secondSessionId).toMatch(/^voice-/);
    expect(firstSessionId).not.toBe("voice-stale");
    expect(secondSessionId).not.toBe(firstSessionId);
  });
});
