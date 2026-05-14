/**
 * Spawn-only background spinner regression — verifies the
 * `<ToolProgressIndicator />` is mounted at the chat layout level rather
 * than gated inside the streaming assistant bubble.
 *
 * Bug repro: the indicator used to live inside `ThreadAssistantBubble`
 * behind `showLiveIndicators === true` (== "streaming"). For spawn_only
 * tools (podcast_generate, fm_tts, deep_search, mofa_slides) the LLM
 * turn settles with `turn/completed` BEFORE the background task starts
 * emitting `tool/progress` envelopes — so the indicator was unmounted
 * just as the long-running work began, and the spinner stayed invisible
 * for the entire spawn_only duration.
 *
 * Fix: lift the indicator into `ChatThreadV2` (one mount per chat
 * layout). It's already scoped to the current session/topic by its
 * internal `eventMatchesScope` check, so a single mount catches every
 * `crew:tool_progress` for the active session — including events that
 * arrive after the streaming bubble has finalised.
 *
 * Coverage here is intentionally narrow: we mount `<ChatThread />` with
 * the session context, dispatch a scoped `crew:tool_progress` event,
 * and assert the spinner row appears even though no `Thread` exists
 * yet (the empty-state branch) and certainly no pending assistant
 * bubble is streaming.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { ChatThread } from "./chat-thread";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";

const SESSION = "sess-bg-spinner";

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

beforeEach(() => {
  // `Composer` reads from `useSession` and never makes network calls
  // during render, but other consumers in `chat-thread.tsx` poke at
  // `localStorage`/window flags. Reset between tests so flag carryover
  // doesn't leak. We also clear any leftover DOM listeners by recreating
  // the body root in `afterEach`.
  localStorage.clear();
  // `crypto.randomUUID` is consumed by the Composer's ghost-bubble code
  // path; jsdom exposes it but if not present we polyfill to keep the
  // composer mount from blowing up.
  if (!("randomUUID" in crypto)) {
    (
      crypto as unknown as { randomUUID: () => string }
    ).randomUUID = () => "00000000-0000-0000-0000-000000000000";
  }
});

afterEach(() => {
  for (const node of [...document.body.children]) {
    node.remove();
  }
  vi.restoreAllMocks();
});

describe("ChatThread tool-progress indicator (lifted)", () => {
  it("renders the spinner row for a scoped crew:tool_progress event even when no streaming bubble exists", () => {
    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );
    // Sanity: no spinner before any event fires.
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();

    // Dispatch a spawn_only-style progress event AFTER the (notional)
    // turn has settled — exactly the case that previously had nowhere
    // to render because `ThreadAssistantBubble` was unmounted.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "podcast_generate",
            message: "[info] synthesizing voice yangmi (segment 1/3)",
            sessionId: SESSION,
          },
        }),
      );
    });

    const row = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("podcast_generate");
    // `[info]` prefix is stripped by the indicator.
    expect(row!.textContent).toContain(
      "synthesizing voice yangmi (segment 1/3)",
    );
    expect(row!.textContent).not.toContain("[info]");
    harness.unmount();
  });

  it("ignores crew:tool_progress events scoped to a different session", () => {
    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "deep_search",
            message: "scanning",
            sessionId: "some-other-session",
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();
    harness.unmount();
  });

  it("clears the spinner row when crew:thinking { thinking: false } fires", () => {
    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "fm_tts",
            message: "synthesizing",
            sessionId: SESSION,
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:thinking", {
          detail: { thinking: false, sessionId: SESSION },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();
    harness.unmount();
  });
});
