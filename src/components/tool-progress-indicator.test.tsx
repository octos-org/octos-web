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

  // ---------------------------------------------------------------------
  // Codex round-1 follow-ups for the chat-layout lift (fix/spinner-for-
  // spawn-only-background). The indicator now lives outside the
  // streaming bubble, so it has to handle three lifecycle cases the
  // per-bubble version was structurally immune to:
  //
  //   1. Terminal clear via `crew:tool_progress { terminal: true }` —
  //      because spawn_only `crew:thinking false` already fired at the
  //      enclosing turn/completed and cannot be relied upon.
  //   2. Scoped clear on `crew:thinking false` — a later normal turn's
  //      completion must NOT blow away a still-running background
  //      task's spinner from an earlier turn.
  //   3. Reset on session/topic change — a stale spinner from session A
  //      must not bleed across to session B.
  // ---------------------------------------------------------------------

  it("does NOT clear on a terminal crew:tool_progress event from a DIFFERENT turn (parallel-tool guard)", () => {
    // Concurrent tool calls in the same session: turn T1 is running a
    // spawn_only podcast_generate; an unrelated synchronous tool call
    // in turn T2 (same session) finishes. T2's terminal frame must
    // not clear T1's still-running background spinner.
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
            tool: "podcast_generate",
            message: "synthesizing",
            sessionId: SESSION,
            turnId: "turn-T1",
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).not.toBeNull();

    // Unrelated T2 tool finishes — must NOT clear T1's spinner.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "shell",
            message: "done",
            sessionId: SESSION,
            turnId: "turn-T2",
            terminal: true,
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).not.toBeNull();

    // BUT a terminal frame for T1 itself clears it.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "podcast_generate",
            message: "done",
            sessionId: SESSION,
            turnId: "turn-T1",
            terminal: true,
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();
    harness.unmount();
  });

  it("clears on a terminal crew:tool_progress event (tool/completed)", () => {
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
            tool: "podcast_generate",
            message: "synthesizing voice yangmi",
            sessionId: SESSION,
            turnId: "turn-spawnonly",
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).not.toBeNull();

    // Terminal frame from `handleToolCompleted` — spinner clears even
    // though `crew:thinking false` will NOT arrive after this (it
    // fired earlier at turn/completed for spawn_only).
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "podcast_generate",
            message: "done",
            sessionId: SESSION,
            turnId: "turn-spawnonly",
            terminal: true,
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();
    harness.unmount();
  });

  it("does NOT clear on crew:thinking false from a DIFFERENT turn (cross-context guard)", () => {
    const ctx = makeSessionCtx();
    const harness = mount(
      <SessionContext.Provider value={ctx}>
        <ToolProgressIndicator />
      </SessionContext.Provider>,
    );
    // Spawn-only progress from turn T1 lights the spinner.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "deep_search",
            message: "scanning",
            sessionId: SESSION,
            turnId: "turn-T1",
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).not.toBeNull();

    // A NEW unrelated LLM turn T2 finishes — its `crew:thinking false`
    // must NOT clear T1's still-running background spinner.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:thinking", {
          detail: {
            thinking: false,
            sessionId: SESSION,
            turnId: "turn-T2",
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).not.toBeNull();

    // BUT a `crew:thinking false` for the OWNING turn does clear it
    // (legacy path; mostly relevant for synchronous tool calls where
    // turn/completed cleanly bounds the work).
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:thinking", {
          detail: {
            thinking: false,
            sessionId: SESSION,
            turnId: "turn-T1",
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();
    harness.unmount();
  });

  it("falls back to the legacy 'any thinking-false clears' path when neither side carries a turnId", () => {
    // Compatibility: server frames without `turnId` still clear the
    // spinner so we don't strand the row on older / partial dispatches.
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

  it("resets the spinner when the active session/topic changes", () => {
    // Light the spinner under session A.
    let ctx = makeSessionCtx();
    const harness = mount(
      <SessionContext.Provider value={ctx}>
        <ToolProgressIndicator />
      </SessionContext.Provider>,
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent("crew:tool_progress", {
          detail: {
            tool: "mofa_slides",
            message: "rendering deck",
            sessionId: SESSION,
            turnId: "turn-A",
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).not.toBeNull();

    // Switch the surrounding SessionContext to a different session.
    ctx = { ...makeSessionCtx(), currentSessionId: "sess-other" };
    act(() => {
      harness.root.render(
        <SessionContext.Provider value={ctx}>
          <ToolProgressIndicator />
        </SessionContext.Provider>,
      );
    });
    // Stale spinner from session A must NOT survive into session B.
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();
    harness.unmount();
  });
});
