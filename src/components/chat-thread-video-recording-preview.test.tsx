import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { ChatThread } from "./chat-thread";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";
import * as ThreadStore from "@/store/thread-store";

const SESSION = "sess-video-preview";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function makeSessionCtx(): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: SESSION,
    historyTopic: undefined,
    currentSessionTitle: "",
    currentSessionStats: null,
    initialMessages: [],
    activeTaskOnServer: false,
    queueMode: null,
    adaptiveMode: null,
    setServerTaskActive: () => {},
    renameSession: () => {},
    updateSessionStats: () => {},
    switchSession: () => {},
    goBack: async () => false,
    createSession: () => SESSION,
    removeSession: async () => {},
    refreshSessions: async () => {},
    markSessionActive: () => {},
  };
}

function mount(node: React.ReactElement): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

class FakeMediaRecorder {
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  state: RecordingState = "inactive";

  constructor(
    public stream: MediaStream,
    public options?: MediaRecorderOptions,
  ) {}

  static isTypeSupported = vi.fn(() => true);

  start = vi.fn(() => {
    this.state = "recording";
  });

  stop = vi.fn(() => {
    this.state = "inactive";
    this.onstop?.();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
});

describe("video recording preview", () => {
  it("binds the live camera stream after the recording preview video mounts", async () => {
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    const button = harness.container.querySelector<HTMLButtonElement>(
      "[data-testid='video-button']",
    );
    expect(button).not.toBeNull();

    await act(async () => {
      button!.click();
      await Promise.resolve();
    });

    const preview = harness.container.querySelector<HTMLVideoElement>("video");
    expect(preview).not.toBeNull();
    expect(preview!.srcObject).toBe(stream);
    expect(play).toHaveBeenCalled();

    harness.unmount();
  });
});
