/**
 * `ToolProgressIndicator` unit tests.
 *
 * PR fix/restore-progress-cost-meta-events regression A:
 *
 * After PR #96 deleted `src/runtime/sse-bridge.ts` (the sole dispatcher
 * of `crew:tool_progress`), the streaming-bubble spinner stopped
 * firing — the listener in this component was still bound but nobody
 * fired the event. The fix lifts `tool/started`, `tool/progress`, and
 * `tool/completed` UI Protocol v1 notifications onto the same DOM
 * event via `ui-protocol-event-router.ts`.
 *
 * These tests exercise the component directly:
 *   1. Dispatching a `crew:tool_progress` window event shows the
 *      spinner row with the tool name + cleaned message.
 *   2. A subsequent `crew:thinking { thinking: false }` clears the row.
 *   3. Scope mismatch (different session id) does NOT show anything.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ToolProgressIndicator } from "./tool-progress-indicator";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";

const SESSION = "sess-tool-progress";

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

afterEach(() => {
  for (const node of [...document.body.children]) {
    node.remove();
  }
});

describe("ToolProgressIndicator", () => {
  it("renders the spinner row when a scoped crew:tool_progress event fires", () => {
    const ctx = makeSessionCtx();
    const harness = mount(
      <SessionContext.Provider value={ctx}>
        <ToolProgressIndicator />
      </SessionContext.Provider>,
    );
    expect(harness.container.querySelector("[data-testid='tool-progress']"))
      .toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "shell",
            message: "[info] running cargo test",
            sessionId: SESSION,
          },
        }),
      );
    });

    const row = harness.container.querySelector("[data-testid='tool-progress']");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("shell");
    // The component strips `[info]/[debug]/[warn]` prefixes — we wrote
    // `[info] running cargo test`, expect `running cargo test`.
    expect(row!.textContent).toContain("running cargo test");
    expect(row!.textContent).not.toContain("[info]");
    harness.unmount();
  });

  it("clears the row when crew:thinking { thinking: false } fires", () => {
    const ctx = makeSessionCtx();
    const harness = mount(
      <SessionContext.Provider value={ctx}>
        <ToolProgressIndicator />
      </SessionContext.Provider>,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: { tool: "shell", message: "running", sessionId: SESSION },
        }),
      );
    });
    expect(harness.container.querySelector("[data-testid='tool-progress']"))
      .not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:thinking", {
          detail: { thinking: false, sessionId: SESSION },
        }),
      );
    });
    expect(harness.container.querySelector("[data-testid='tool-progress']"))
      .toBeNull();
    harness.unmount();
  });

  it("ignores crew:tool_progress events scoped to a different session", () => {
    const ctx = makeSessionCtx();
    const harness = mount(
      <SessionContext.Provider value={ctx}>
        <ToolProgressIndicator />
      </SessionContext.Provider>,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "shell",
            message: "running",
            sessionId: "some-other-session",
          },
        }),
      );
    });
    expect(harness.container.querySelector("[data-testid='tool-progress']"))
      .toBeNull();
    harness.unmount();
  });
});
