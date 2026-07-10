/**
 * Cancel-vs-seed ordering (codex #261 round-2 P1).
 *
 * The send path parks `turn/start` behind `whenThinkingSeeded` during
 * the initial `session/open` handshake. A cancel clicked in that window
 * must be gated on the SAME promise, or `turn/interrupt` reaches the
 * bridge queue first, no-ops server-side, and the supposedly cancelled
 * turn runs anyway. This pins: (1) the interrupt defers while the scope
 * is unseeded; (2) it fires after the seed; (3) seeded steady-state
 * cancels still go through.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const interruptTurn = vi.fn().mockResolvedValue({ interrupted: true });
vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: () => ({ interruptTurn }),
}));

import { ChatThread } from "./chat-thread";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";
import * as ThreadStore from "@/store/thread-store";
import {
  __resetThinkingStoreForTest,
  markThinkingSeeded,
} from "@/store/thinking-store";

const SESSION = "sess-cancel-ordering";

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

function mountWithStreamingTurn(): MountedHarness {
  // A streaming pendingAssistant makes `isRunning` true → Cancel button.
  ThreadStore.addUserMessage(SESSION, {
    text: "long question",
    clientMessageId: "cmid-cancel-order",
  });
  ThreadStore.appendAssistantToken("cmid-cancel-order", "thinking…");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );
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

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
  __resetThinkingStoreForTest();
  interruptTurn.mockClear();
});

describe("cancel ordering vs thinking-seed gate", () => {
  it("defers turn/interrupt until the scope seeds, then fires", async () => {
    const harness = mountWithStreamingTurn();
    const cancelBtn = harness.container.querySelector(
      '[data-testid="cancel-button"]',
    ) as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();

    await act(async () => {
      cancelBtn.click();
    });
    // Scope not seeded (session/open still pending) → interrupt parked.
    expect(interruptTurn).not.toHaveBeenCalled();

    await act(async () => {
      markThinkingSeeded(SESSION);
      // Let the gated .then continuation run.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(interruptTurn).toHaveBeenCalledWith(
      "cmid-cancel-order",
      "user cancelled",
    );
    harness.unmount();
  });

  it("fires immediately (one microtask) when the scope is already seeded", async () => {
    markThinkingSeeded(SESSION);
    const harness = mountWithStreamingTurn();
    const cancelBtn = harness.container.querySelector(
      '[data-testid="cancel-button"]',
    ) as HTMLButtonElement;
    await act(async () => {
      cancelBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(interruptTurn).toHaveBeenCalledTimes(1);
    harness.unmount();
  });
});
