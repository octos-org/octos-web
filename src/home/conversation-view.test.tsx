import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationView } from "./conversation-view";

const threadMock = vi.hoisted(() => ({
  threads: [
    {
      id: "thread-1",
      userMsg: {
        id: "user-1",
        role: "user",
        text: "What happened?",
        timestamp: Date.UTC(2026, 5, 15, 12, 0),
        files: [],
        toolCalls: [],
      },
      responses: [
        {
          id: "assistant-1",
          role: "assistant",
          text: "Here is the short answer.",
          timestamp: Date.UTC(2026, 5, 15, 12, 1),
          files: [],
          toolCalls: [],
        },
      ],
      pendingAssistant: null,
    },
  ],
}));

vi.mock("@/runtime/session-context", () => ({
  useSession: () => ({
    currentSessionId: "session-1",
    historyTopic: null,
    refreshSessions: vi.fn(),
    markSessionActive: vi.fn(),
  }),
}));

vi.mock("@/store/thread-store", () => ({
  useThreads: () => threadMock.threads,
}));

vi.mock("@/runtime/ui-protocol-send", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: () => null,
}));

vi.mock("@/api/files", () => ({
  buildAuthenticatedFileUrl: (path: string) => path,
}));

vi.mock("./home-settings-context", () => ({
  useHomeSettings: () => ({
    idleSeconds: 60,
    strings: {
      backToStandby: "Back",
      inputPlaceholder: "Say something...",
      send: "Send",
      suggestions: [],
    },
  }),
}));

vi.mock("./use-smooth", () => ({
  useSmooth: (text: string) => text,
}));

describe("ConversationView", () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("can read assistant responses aloud with browser TTS", () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    const utterances: SpeechSynthesisUtterance[] = [];

    vi.stubGlobal("speechSynthesis", {
      speak: (utterance: SpeechSynthesisUtterance) => {
        utterances.push(utterance);
        speak(utterance);
      },
      cancel,
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;

        constructor(text: string) {
          this.text = text;
        }
      },
    );

    render(<ConversationView onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Read response aloud" }));

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(utterances[0].text).toBe("Here is the short answer.");
  });
});
