import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VoiceView } from "./voice-view";

vi.mock("./use-voice-conversation", () => ({
  useVoiceConversation: () => ({
    state: "listening",
    lastUserText: "你好",
    lastAssistantText: "在的",
    error: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    interrupt: vi.fn(),
  }),
}));

describe("VoiceView", () => {
  it("renders orb + captions and exits via the × button", () => {
    const onBack = vi.fn();
    render(<VoiceView sessionId="s1" onBack={onBack} />);
    expect(screen.getByText("在的")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("exit voice mode"));
    expect(onBack).toHaveBeenCalled();
  });
});
