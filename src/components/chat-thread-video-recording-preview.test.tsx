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

  static instances: FakeMediaRecorder[] = [];

  constructor(
    public stream: MediaStream,
    public options?: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  static isTypeSupported = vi.fn(() => true);

  start = vi.fn(() => {
    this.state = "recording";
  });

  stop = vi.fn(() => {
    this.state = "inactive";
    this.onstop?.();
  });

  /** Test helper: deliver a chunk of `size` bytes to this recorder. */
  emitChunk(size: number): void {
    this.ondataavailable?.({
      data: new Blob(["x".repeat(size)]),
    } as unknown as BlobEvent);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
  FakeMediaRecorder.instances = [];
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
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

  it("a trailing chunk from a stopped recorder does not contaminate the next recording", async () => {
    // #245 P2: the recorder chunk buffer must be per-recorder. A shared
    // `chunksRef` (reset at the start of each recording) let a late
    // `dataavailable` from a just-stopped recorder push into the NEW
    // recording's buffer, so the second recording's blob contained the first
    // recording's trailing audio/video.
    const stream = {
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    // Capture the blob each recording produces (video mode → createObjectURL).
    // jsdom has no URL.createObjectURL, so define it (configurable → afterEach
    // deletes it).
    const blobs: Blob[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: (obj: Blob) => {
        blobs.push(obj);
        return "blob:mock";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: () => {},
    });

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );
    const button = () =>
      harness.container.querySelector<HTMLButtonElement>(
        "[data-testid='video-button']",
      )!;

    // Recording A: start, one 200-byte chunk, then stop (builds A's blob).
    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    const recA = FakeMediaRecorder.instances[0];
    await act(async () => {
      recA.emitChunk(200);
    });
    await act(async () => {
      button().click(); // stop A
      await Promise.resolve();
    });

    // Recording B starts (resets any shared buffer)...
    await act(async () => {
      button().click();
      await Promise.resolve();
    });
    const recB = FakeMediaRecorder.instances[1];
    expect(recB).not.toBe(recA);
    // ...then A's TRAILING chunk lands late, and B records its own 50 bytes.
    await act(async () => {
      recA.emitChunk(999); // stale trailing chunk from the stopped recorder
      recB.emitChunk(50);
    });
    await act(async () => {
      button().click(); // stop B (builds B's blob)
      await Promise.resolve();
    });

    // Two recordings produced two blobs; B's must be its own 50 bytes only —
    // NOT 50 + 999 (contaminated by A's trailing chunk).
    expect(blobs.length).toBeGreaterThanOrEqual(2);
    const blobB = blobs[blobs.length - 1];
    expect(blobB.size).toBe(50);

    harness.unmount();
  });
});
