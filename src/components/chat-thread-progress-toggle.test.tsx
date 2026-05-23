/**
 * Progress-chip collapse/expand toggle — verifies the per-bubble
 * `ToolCallBubble` chip list can be collapsed and expanded by the user,
 * defaults to expanded while the tool is running, and auto-collapses
 * when the tool settles.
 *
 * Context: after the React.memo immutability fix (commit `1a20b7a9`),
 * the chip list re-renders correctly on every `tool/progress` heartbeat.
 * That exposed a UX problem: a long-running `run_pipeline` (10-30 min)
 * accumulates 300+ chips that dominate the scrollback. This file pins
 * the collapse/expand behavior so the affordance can't silently regress.
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
  __resetRouterStateForTest,
  __resetTurnMetaForTest,
  handleTaskUpdated,
  handleToolStarted,
  handleToolProgress,
  handleTurnCompleted,
  handleTurnStarted,
} from "@/runtime/ui-protocol-event-router";

const SESSION = "sess-toggle";

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

function pumpProgress(
  cmid: string,
  toolCallId: string,
  messages: string[],
): void {
  act(() => {
    for (const msg of messages) {
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          message: msg,
        },
      );
    }
  });
}

function setupRunningPipeline(cmid: string, toolCallId: string): void {
  act(() => {
    ThreadStore.addUserMessage(SESSION, {
      text: "run pipeline",
      clientMessageId: cmid,
    });
  });
  act(() => {
    handleTurnStarted(
      { sessionId: SESSION },
      { session_id: SESSION, turn_id: cmid },
    );
    handleToolStarted(
      { sessionId: SESSION },
      {
        session_id: SESSION,
        turn_id: cmid,
        tool_call_id: toolCallId,
        // Non-spawn_only tool: shell. Spawn_only tools (run_pipeline /
        // podcast / mofa_*) now default to collapsed per dspfac UX
        // request 2026-05-22; default-expanded assertions need a
        // non-spawn_only baseline.
        tool_name: "shell",
      },
    );
  });
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
  __resetRouterStateForTest();
  __resetTurnMetaForTest();
});

describe("ToolCallBubble progress-chip collapse toggle", () => {
  it("defaults to expanded while the tool is still running and renders every chip", () => {
    const cmid = "turn-running-default";
    const toolCallId = "tc-pipeline-default";
    setupRunningPipeline(cmid, toolCallId);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    const messages = [
      "Pipeline 'research' started (6 nodes)",
      "Pipeline 'research' running: plan (1/6, 5s elapsed)",
      "Pipeline 'research' running: plan (1/6, 10s elapsed)",
      "Pipeline 'research' running: search_comparison (2/6, 15s elapsed)",
    ];
    pumpProgress(cmid, toolCallId, messages);

    const bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-progress-expanded")).toBe("true");
    expect(bubble!.getAttribute("data-progress-count")).toBe("4");

    const timeline = harness.container.querySelector(
      "[data-testid='tool-call-runtime-timeline']",
    );
    expect(timeline).not.toBeNull();
    expect(timeline!.getAttribute("data-progress-mode")).toBe("expanded");
    const rendered = timeline!.textContent ?? "";
    for (const msg of messages) {
      expect(rendered).toContain(msg);
    }

    harness.unmount();
  });

  it("click-to-collapse hides all but the latest chip and shows a hidden-count summary", () => {
    const cmid = "turn-click-collapse";
    const toolCallId = "tc-pipeline-collapse";
    setupRunningPipeline(cmid, toolCallId);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    const messages = [
      "Pipeline 'research' started (6 nodes)",
      "Pipeline 'research' running: plan (1/6, 5s elapsed)",
      "Pipeline 'research' running: search_comparison (2/6, 10s elapsed)",
      "Pipeline 'research' running: search_comparison (2/6, 15s elapsed)",
      "Pipeline 'research' running: synth (5/6, 20s elapsed)",
    ];
    pumpProgress(cmid, toolCallId, messages);

    const toggle = harness.container.querySelector<HTMLButtonElement>(
      "[data-testid='tool-call-runtime-toggle']",
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    expect(toggle!.textContent).toContain("Hide");

    act(() => {
      toggle!.click();
    });

    const bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble!.getAttribute("data-progress-expanded")).toBe("false");

    const timeline = harness.container.querySelector(
      "[data-testid='tool-call-runtime-timeline']",
    );
    expect(timeline).not.toBeNull();
    expect(timeline!.getAttribute("data-progress-mode")).toBe("collapsed");

    const rendered = timeline!.textContent ?? "";
    // Latest chip text MUST remain visible in collapsed mode so the user
    // can still see current activity at a glance.
    expect(rendered).toContain(messages[messages.length - 1]);
    // Earlier chips MUST be hidden — only the latest one renders.
    expect(rendered).not.toContain(messages[0]);
    expect(rendered).not.toContain(messages[1]);
    expect(rendered).not.toContain(messages[2]);

    // Hidden-count summary on the toggle button.
    const refreshedToggle = harness.container.querySelector<HTMLButtonElement>(
      "[data-testid='tool-call-runtime-toggle']",
    );
    expect(refreshedToggle).not.toBeNull();
    expect(refreshedToggle!.getAttribute("aria-expanded")).toBe("false");
    expect(refreshedToggle!.textContent).toContain("Show 4 more");
    // Accessibility: the aria-label spells out the action with the count.
    expect(refreshedToggle!.getAttribute("aria-label")).toMatch(
      /Show 4 more progress updates/,
    );

    harness.unmount();
  });

  it("click-to-expand after collapse restores the full chip list", () => {
    const cmid = "turn-click-expand";
    const toolCallId = "tc-pipeline-expand";
    setupRunningPipeline(cmid, toolCallId);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    const messages = [
      "Pipeline 'research' started (6 nodes)",
      "Pipeline 'research' running: plan (1/6, 5s elapsed)",
      "Pipeline 'research' running: synth (5/6, 20s elapsed)",
    ];
    pumpProgress(cmid, toolCallId, messages);

    const toggle = harness.container.querySelector<HTMLButtonElement>(
      "[data-testid='tool-call-runtime-toggle']",
    );
    expect(toggle).not.toBeNull();

    // Collapse, then expand.
    act(() => toggle!.click());
    const collapsedTimeline = harness.container.querySelector(
      "[data-testid='tool-call-runtime-timeline']",
    );
    expect(collapsedTimeline!.getAttribute("data-progress-mode")).toBe(
      "collapsed",
    );

    const collapsedToggle = harness.container.querySelector<HTMLButtonElement>(
      "[data-testid='tool-call-runtime-toggle']",
    );
    act(() => collapsedToggle!.click());

    const expandedTimeline = harness.container.querySelector(
      "[data-testid='tool-call-runtime-timeline']",
    );
    expect(expandedTimeline!.getAttribute("data-progress-mode")).toBe(
      "expanded",
    );
    const rendered = expandedTimeline!.textContent ?? "";
    for (const msg of messages) {
      expect(rendered).toContain(msg);
    }

    harness.unmount();
  });

  it("auto-collapses when the tool transitions running -> complete", () => {
    const cmid = "turn-auto-collapse";
    const toolCallId = "tc-pipeline-auto";
    setupRunningPipeline(cmid, toolCallId);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    const messages = [
      "Pipeline 'research' started (6 nodes)",
      "Pipeline 'research' running: plan (1/6, 5s elapsed)",
      "Pipeline 'research' running: synth (5/6, 20s elapsed)",
    ];
    pumpProgress(cmid, toolCallId, messages);

    // While running, the bubble is expanded.
    let bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble!.getAttribute("data-progress-expanded")).toBe("true");

    // Settle the tool — task/updated with state=completed flips
    // status to "complete" via the router's `setToolCallStatus` path.
    act(() => {
      handleTurnCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
        },
      );
      handleTaskUpdated(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          task_id: toolCallId,
          state: "completed",
        },
      );
    });

    bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    // Auto-collapsed once the tool settled.
    expect(bubble!.getAttribute("data-progress-expanded")).toBe("false");
    const timeline = harness.container.querySelector(
      "[data-testid='tool-call-runtime-timeline']",
    );
    expect(timeline!.getAttribute("data-progress-mode")).toBe("collapsed");
    // Latest chip text is still visible in collapsed mode.
    expect(timeline!.textContent ?? "").toContain(messages[messages.length - 1]);

    harness.unmount();
  });

  it("hides the toggle entirely when only a single progress chip exists", () => {
    const cmid = "turn-single-chip";
    const toolCallId = "tc-pipeline-single";
    setupRunningPipeline(cmid, toolCallId);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    pumpProgress(cmid, toolCallId, ["Pipeline 'research' started (6 nodes)"]);

    // The toggle row is suppressed when there's nothing to hide
    // (collapsed view would be identical to expanded view).
    const toggle = harness.container.querySelector(
      "[data-testid='tool-call-runtime-toggle']",
    );
    expect(toggle).toBeNull();
    // But the chip is still rendered.
    const timeline = harness.container.querySelector(
      "[data-testid='tool-call-runtime-timeline']",
    );
    expect(timeline).not.toBeNull();
    expect(timeline!.textContent).toContain(
      "Pipeline 'research' started (6 nodes)",
    );

    harness.unmount();
  });
});
