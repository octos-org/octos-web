/**
 * Integration test for the copy-as-markdown button slot in
 * `ThreadAssistantBubble`. Exercises the render-time gating contract:
 *
 *   - A FINALIZED assistant message (`status: "complete"` and no live
 *     indicators) shows the copy button next to `ThreadMessageMeta`.
 *   - A STREAMING assistant message (or one in `showLiveIndicators`
 *     mode) suppresses the button so partial content can't leak to the
 *     clipboard.
 *
 * We mount `ThreadAssistantBubble` directly with hand-built
 * `ThreadMessage` records — no SessionContext or Composer plumbing
 * required.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { ThreadAssistantBubble } from "./chat-thread";
import type { ThreadMessage } from "@/store/thread-store";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";

function makeSessionCtx(): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: "sess-copy-md",
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
    createSession: () => "sess-copy-md",
    removeSession: async () => {},
    refreshSessions: async () => {},
    markSessionActive: () => {},
  };
}

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
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

function makeAssistant(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: overrides.id ?? "msg-1",
    role: "assistant",
    text: overrides.text ?? "# Hello\n\nworld",
    files: [],
    toolCalls: [],
    status: overrides.status ?? "complete",
    timestamp: 1700000000000,
    ...overrides,
  };
}

afterEach(() => {
  for (const node of [...document.body.children]) {
    node.remove();
  }
});

describe("ThreadAssistantBubble copy-markdown button", () => {
  it("renders the copy button on finalized assistant messages", () => {
    const msg = makeAssistant({
      text: "## Done\n\nFinal answer.",
      status: "complete",
    });
    const { container, unmount } = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ThreadAssistantBubble
          message={msg}
          isStreaming={false}
          showLiveIndicators={false}
          threadId="thr-1"
        />
      </SessionContext.Provider>,
    );
    const btn = container.querySelector(
      "[data-testid='copy-markdown-button']",
    );
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("Copy as markdown");
    unmount();
  });

  it("does NOT render the copy button while the assistant is streaming", () => {
    const msg = makeAssistant({
      text: "partial...",
      status: "streaming",
    });
    const { container, unmount } = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ThreadAssistantBubble
          message={msg}
          isStreaming={true}
          showLiveIndicators={true}
          threadId="thr-2"
        />
      </SessionContext.Provider>,
    );
    expect(
      container.querySelector("[data-testid='copy-markdown-button']"),
    ).toBeNull();
    unmount();
  });

  it("does NOT render the copy button while live indicators are still pinned (turn not settled)", () => {
    // A pending assistant briefly flips `status: "complete"` ahead of the
    // turn fully settling. The render gate also checks
    // `!showLiveIndicators` so we don't flash an icon during that window.
    const msg = makeAssistant({
      text: "interim",
      status: "complete",
    });
    const { container, unmount } = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ThreadAssistantBubble
          message={msg}
          isStreaming={false}
          showLiveIndicators={true}
          threadId="thr-3"
        />
      </SessionContext.Provider>,
    );
    expect(
      container.querySelector("[data-testid='copy-markdown-button']"),
    ).toBeNull();
    unmount();
  });

  it("does NOT render the copy button on a finalized assistant with empty text (file-only)", () => {
    const msg = makeAssistant({ text: "", status: "complete" });
    const { container, unmount } = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ThreadAssistantBubble
          message={msg}
          isStreaming={false}
          showLiveIndicators={false}
          threadId="thr-4"
        />
      </SessionContext.Provider>,
    );
    expect(
      container.querySelector("[data-testid='copy-markdown-button']"),
    ).toBeNull();
    unmount();
  });
});
