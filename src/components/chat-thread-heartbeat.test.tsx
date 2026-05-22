/**
 * Heartbeat-progress regression — verifies the `ToolCallBubble` chip
 * list inside the finalised assistant bubble re-renders on every
 * `tool/progress` event for a spawn_only `run_pipeline` call.
 *
 * Bug repro (2026-05-15): server PR #962/#964 introduced a 5-second
 * heartbeat that emits a `ProgressEvent::ToolProgress` with a fresh
 * elapsed-seconds suffix on every tick during `run_pipeline`. The wire
 * frames reach the SPA fine (verified server-side: 72 ticks logged,
 * `ledger.events.dropped=0`), but the chat bubble visibly froze on the
 * first 2-3 progress chips for the entire 20-minute pipeline run.
 *
 * Root cause: `ThreadStore.{appendToolProgress, addToolCall,
 * setToolCallStatus}` mutated `ThreadMessage.toolCalls[i].progress` in
 * place. `ThreadAssistantBubble` is wrapped in `React.memo`, whose
 * default shallow comparison treats `message === message` as "skip
 * re-render". Once `turn/completed` finalised the foreground turn and
 * the bubble was promoted from `pendingAssistant` to a member of
 * `responses[]`, the `message` reference never changed again — so
 * every subsequent in-place push to `progress` was invisible to the
 * renderer even though the store state had advanced.
 *
 * Fix: every tool-call mutation immutably replaces the surrounding
 * `ThreadMessage` (and its `toolCalls` array, and the affected entry).
 * `replaceAssistantSlot` writes the new ref into either
 * `thread.pendingAssistant` or `thread.responses[i]`.
 *
 * This file mounts the real `ChatThread`, simulates a spawn_only
 * `run_pipeline` flow (started → progress → completed → heartbeat
 * frames), and asserts the visible chip text rolls forward.
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
  handleToolStarted,
  handleToolProgress,
  handleTurnCompleted,
  handleTurnStarted,
} from "@/runtime/ui-protocol-event-router";

const SESSION = "sess-heartbeat";

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
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
  __resetRouterStateForTest();
  __resetTurnMetaForTest();
});

describe("run_pipeline heartbeat chip list", () => {
  it("ThreadStore returns a NEW ThreadMessage reference after appendToolProgress (memo wakes up)", () => {
    // Direct store check — proves the immutable update fix without
    // going through React.
    const cmid = "turn-store";
    ThreadStore.addUserMessage(SESSION, { text: "go", clientMessageId: cmid });
    ThreadStore.addToolCall(cmid, "tc-store", "run_pipeline");
    const [threadBefore] = ThreadStore.getThreads(SESSION);
    const refBefore = threadBefore.pendingAssistant;
    expect(refBefore).not.toBeNull();
    ThreadStore.appendToolProgress(cmid, "tc-store", "first heartbeat");
    const [threadAfter] = ThreadStore.getThreads(SESSION);
    const refAfter = threadAfter.pendingAssistant;
    expect(refAfter).not.toBeNull();
    // Critical assertion: identity must change so React.memo's shallow
    // comparison detects the update.
    expect(refAfter).not.toBe(refBefore);
    // The new toolCalls array is also a new reference.
    expect(refAfter!.toolCalls).not.toBe(refBefore!.toolCalls);
  });

  it("ToolCallBubble chip list updates after 5 heartbeat frames even on a finalised bubble", () => {
    // End-to-end: render the full ChatThread, simulate the real
    // spawn_only run_pipeline sequence (tool/started, initial progress,
    // turn/completed which finalises the bubble, then 5 heartbeat
    // frames). Assert all 6 progress messages (1 initial + 5 heartbeats)
    // are visible in the bubble's chip list.
    const cmid = "turn-end-to-end";
    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "run pipeline",
        clientMessageId: cmid,
      });
    });

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

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
          tool_call_id: "tc-pipeline",
          tool_name: "run_pipeline",
        },
      );
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: "tc-pipeline",
          message: "Pipeline 'cerebras_research' started (3 nodes)",
        },
      );
      handleTurnCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          message_id: "msg-1",
          persisted_at: new Date().toISOString(),
        },
      );
    });

    const heartbeatMessages = [
      "Pipeline 'cerebras_research' running: plan_and_search (0/3 nodes, 5s elapsed)",
      "Pipeline 'cerebras_research' running: plan_and_search (0/3 nodes, 10s elapsed)",
      "Pipeline 'cerebras_research' running: plan_and_search (0/3 nodes, 15s elapsed)",
      "Pipeline 'cerebras_research' running: plan_and_search (0/3 nodes, 20s elapsed)",
      "Pipeline 'cerebras_research' running: plan_and_search (0/3 nodes, 25s elapsed)",
    ];
    for (const msg of heartbeatMessages) {
      act(() => {
        handleToolProgress(
          { sessionId: SESSION },
          {
            session_id: SESSION,
            turn_id: cmid,
            tool_call_id: "tc-pipeline",
            message: msg,
          },
        );
      });
    }

    // The bubble starts expanded (status === "running") and stays that
    // way: `run_pipeline` is in `SPAWN_ONLY_TOOL_NAMES`, so the
    // `turn/completed` sweep no longer flips the chip to `complete`
    // (codex PR #147 BLOCKER, 2026-05-22). Without the running →
    // settled transition the auto-collapse useEffect doesn't fire, so
    // the timeline is visible without a toggle click. The point of
    // this regression test is that every chip survived in the store
    // across the finalise transition (the React.memo bug it pins).
    // Collapse UX is exercised separately in
    // `chat-thread-progress-toggle.test.tsx`.
    const timeline = harness.container.querySelector(
      "[data-testid='tool-call-runtime-timeline']",
    );
    expect(timeline).not.toBeNull();
    const rendered = timeline!.textContent ?? "";
    // The initial "Pipeline 'cerebras_research' started (3 nodes)"
    // line must still be there.
    expect(rendered).toContain("Pipeline 'cerebras_research' started (3 nodes)");
    // Every heartbeat must show up.
    for (const msg of heartbeatMessages) {
      expect(rendered).toContain(msg);
    }
    // The latest heartbeat must NOT be the only thing visible (verifies
    // we're not just overwriting the chip).
    expect(rendered).toContain("5s elapsed");
    expect(rendered).toContain("25s elapsed");
    harness.unmount();
  });
});
