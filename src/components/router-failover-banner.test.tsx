/**
 * Wave4-A router failover banner unit tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { RouterFailoverBanner } from "./router-failover-banner";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";

const SESSION = "sess-failover-banner";

function makeSessionCtx(sessionId = SESSION): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: sessionId,
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
    createSession: () => sessionId,
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
    root.render(
      <SessionContext.Provider value={makeSessionCtx()}>
        {node}
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("RouterFailoverBanner", () => {
  it("renders nothing until a crew:router_failover event fires", () => {
    const harness = mount(<RouterFailoverBanner />);
    try {
      expect(
        harness.container.querySelector(
          "[data-testid='router-failover-banner']",
        ),
      ).toBeNull();
    } finally {
      harness.unmount();
    }
  });

  it("shows the banner with from/to/reason/elapsedMs when a failover event fires", () => {
    const harness = mount(<RouterFailoverBanner />);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("crew:router_failover", {
            detail: {
              sessionId: SESSION,
              from: "openrouter/openai/gpt-5",
              to: "openrouter/anthropic/claude-opus-4-7",
              reason: "circuit_breaker_open",
              elapsedMs: 1500,
            },
          }),
        );
      });
      const banner = harness.container.querySelector(
        "[data-testid='router-failover-banner']",
      );
      expect(banner).not.toBeNull();
      const text = banner?.textContent ?? "";
      expect(text).toContain("openrouter/openai/gpt-5");
      expect(text).toContain("openrouter/anthropic/claude-opus-4-7");
      expect(text).toContain("circuit_breaker_open");
      expect(text).toContain("1500ms");
    } finally {
      harness.unmount();
    }
  });

  it("drops events for other sessions (codex Wave4-A P2 scope guard)", () => {
    const harness = mount(<RouterFailoverBanner />);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("crew:router_failover", {
            detail: {
              sessionId: "different-session",
              from: "a/m1",
              to: "b/m2",
              reason: "r",
              elapsedMs: 100,
            },
          }),
        );
      });
      expect(
        harness.container.querySelector(
          "[data-testid='router-failover-banner']",
        ),
      ).toBeNull();
    } finally {
      harness.unmount();
    }
  });

  it("auto-dismisses after 4 seconds", () => {
    const harness = mount(<RouterFailoverBanner />);
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("crew:router_failover", {
            detail: {
              sessionId: SESSION,
              from: "a/m1",
              to: "b/m2",
              reason: "r",
              elapsedMs: 100,
            },
          }),
        );
      });
      expect(
        harness.container.querySelector(
          "[data-testid='router-failover-banner']",
        ),
      ).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(
        harness.container.querySelector(
          "[data-testid='router-failover-banner']",
        ),
      ).toBeNull();
    } finally {
      harness.unmount();
    }
  });
});
