/**
 * Composer thinking-effort selector (TUI `/thinking` parity).
 *
 * The selector is per-session state backed by `thinking-store`; the send
 * path (`buildTurnStartExtras`) reads the same store so every user turn
 * carries the choice — omission is meaningful to the server (clears the
 * persisted override), so the selector MUST round-trip through the store,
 * not component-local state.
 */

import { afterEach, describe, expect, it } from "vitest";
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
import {
  __resetThinkingStoreForTest,
  getThinkingEffort,
  setThinkingEffort,
} from "@/store/thinking-store";

const SESSION = "sess-thinking-selector";

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

function mountThread(): MountedHarness {
  return mount(
    <SessionContext.Provider value={makeSessionCtx()}>
      <ChatThread />
    </SessionContext.Provider>,
  );
}

function getSelect(harness: MountedHarness): HTMLSelectElement {
  const el = harness.container.querySelector(
    '[data-testid="thinking-effort-select"]',
  ) as HTMLSelectElement | null;
  expect(el).toBeTruthy();
  return el as HTMLSelectElement;
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
  __resetThinkingStoreForTest();
});

describe("composer thinking-effort selector", () => {
  it("renders defaulted and writes the store on change", () => {
    const harness = mountThread();
    const select = getSelect(harness);
    expect(select.value).toBe("");

    act(() => {
      select.value = "high";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(getThinkingEffort(SESSION)).toBe("high");
    expect(getSelect(harness).value).toBe("high");
    harness.unmount();
  });

  it("reflects a store value seeded before mount (session/open restore path)", () => {
    setThinkingEffort(SESSION, "medium");
    const harness = mountThread();
    expect(getSelect(harness).value).toBe("medium");
    harness.unmount();
  });

  it("selecting default clears the stored override", () => {
    setThinkingEffort(SESSION, "max");
    const harness = mountThread();
    const select = getSelect(harness);
    expect(select.value).toBe("max");
    act(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(getThinkingEffort(SESSION)).toBe(null);
    harness.unmount();
  });
});
