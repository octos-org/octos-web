/**
 * Spawn-only background spinner placement regression
 * (2026-05-14 follow-up to commit 86fb70e).
 *
 * Setup:
 *
 *   - Commit 86fb70e lifted `<ToolProgressIndicator />` from inside
 *     `ThreadAssistantBubble` to chat-layout level (above the
 *     `Composer`) so the spinner could survive `turn/completed` for
 *     spawn_only tools (run_pipeline / podcast_generate / fm_tts /
 *     deep_search / mofa_slides) whose `tool/progress` envelopes
 *     arrive AFTER the LLM turn settles.
 *
 *   - That lift caused a recurring user-reported UX bug: for a long
 *     spawn_only run (typically `run_pipeline`, ~25 min), the
 *     "running" badge sat ABOVE the input prompt for the entire
 *     background run, detached from the bubble it described.
 *
 *   - Commit `1a20b7a` immutable tool-call updates fix means the
 *     bubble now re-renders on every heartbeat (`React.memo`'s shallow
 *     compare wakes up because every store mutation produces a new
 *     `ThreadMessage` reference). So we can host the spinner inside
 *     the bubble again WITHOUT the spawn_only regression the lift was
 *     trying to fix.
 *
 * What this file covers:
 *
 *   1. The spinner is anchored INSIDE the assistant bubble, not above
 *      the composer. We assert the DOM ancestry is
 *      `[data-testid='assistant-message']` -> `[data-testid='tool-progress']`.
 *
 *   2. For spawn_only, the spinner stays visible AFTER `turn/completed`
 *      because the bubble has at least one tool call still `running`.
 *      A `task/updated completed` event (which flips the tool status
 *      to "complete" and dispatches a `terminal: true` progress
 *      event) clears it.
 *
 *   3. Cross-session events still drop (scope filter still applies).
 *
 *   4. Cross-turn events drop (per-bubble `turnId` filter): a
 *      `crew:tool_progress` for a different bubble's turn does NOT
 *      light up THIS bubble's spinner.
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
import * as ThreadStore from "@/store/thread-store";
import {
  __resetRouterStateForTest,
  __resetTurnMetaForTest,
  handleTaskUpdated,
  handleToolCompleted,
  handleToolProgress,
  handleToolStarted,
  handleTurnCompleted,
  handleTurnStarted,
} from "@/runtime/ui-protocol-event-router";

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
  localStorage.clear();
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
  ThreadStore.__resetForTests();
  __resetRouterStateForTest();
  __resetTurnMetaForTest();
  vi.restoreAllMocks();
});

describe("Spawn-only spinner placement (per-bubble)", () => {
  it("anchors the spinner INSIDE the assistant bubble, not at chat-layout level above the composer", () => {
    // Drive a spawn_only run_pipeline scenario through the real
    // router so we get an end-to-end check of placement.
    const cmid = "turn-anchor";
    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "深度研究 TSMC 的 CoWoS 和 Intel 的 EMIB 的区别",
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
          message: "Pipeline 'cerebras_research' running: plan_and_search",
        },
      );
      handleTurnCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          message_id: "msg-anchor",
          persisted_at: new Date().toISOString(),
        },
      );
    });

    // After turn/completed the bubble has been promoted to
    // responses[]; the foreground turn is settled. Fire a heartbeat
    // exactly like the 5s server heartbeat.
    act(() => {
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: "tc-pipeline",
          message:
            "Pipeline 'cerebras_research' running: plan_and_search (0/3 nodes, 5s elapsed)",
        },
      );
    });

    const spinnerRow = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(spinnerRow).not.toBeNull();
    // Critical anti-regression check: the spinner row MUST be a
    // descendant of an `assistant-message` bubble. Pre-fix it was a
    // sibling of `Composer`, detached from any bubble.
    const enclosingBubble = spinnerRow!.closest(
      "[data-testid='assistant-message']",
    );
    expect(enclosingBubble).not.toBeNull();
    expect(spinnerRow!.textContent).toContain("run_pipeline");
    expect(spinnerRow!.textContent).toContain("5s elapsed");

    harness.unmount();
  });

  it("keeps the spinner visible after turn/completed for as long as a tool call on the bubble is still running", () => {
    const cmid = "turn-spawnonly";
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
          tool_call_id: "tc-x",
          tool_name: "run_pipeline",
        },
      );
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: "tc-x",
          message: "starting",
        },
      );
      handleTurnCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          message_id: "msg-x",
          persisted_at: new Date().toISOString(),
        },
      );
    });

    // After turn/completed: tool is STILL running (spawn_only).
    // Spinner must remain visible.
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).not.toBeNull();

    // Heartbeat refresh keeps the latest message on the spinner row.
    act(() => {
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: "tc-x",
          message: "still running, 10s elapsed",
        },
      );
    });
    // codex PR #147 BLOCKER (2026-05-22): `finalizeAssistant`'s
    // `turn/completed` sweep is now gated by `SPAWN_ONLY_TOOL_NAMES`.
    // `run_pipeline` is in the set, so the chip stays in `running`
    // until `task/updated:completed` lands — even though the
    // foreground LLM turn has finalised. The spinner row reflects
    // that the BG work is still in flight.
    const row = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("10s elapsed");
    expect(row!.getAttribute("data-tool-status")).toBe("running");
    expect(
      row!.querySelector("[data-testid='tool-progress-spinner']"),
    ).not.toBeNull();
    expect(
      row!.querySelector("[data-testid='tool-progress-complete-icon']"),
    ).toBeNull();

    // The explicit `tool/completed` ack (synchronous foreground leg
    // of a spawn_only tool) is intentionally a no-op for the chip
    // status (Defect A). Heartbeats refresh the text; the chip stays
    // `running` until `task/updated:completed`.
    act(() => {
      handleToolCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: "tc-x",
          tool_name: "run_pipeline",
          success: true,
        },
      );
    });
    const rowAfterToolCompleted = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(rowAfterToolCompleted).not.toBeNull();
    expect(rowAfterToolCompleted!.textContent).toContain("10s elapsed");
    expect(rowAfterToolCompleted!.getAttribute("data-tool-status")).toBe(
      "running",
    );
    expect(
      rowAfterToolCompleted!.querySelector(
        "[data-testid='tool-progress-spinner']",
      ),
    ).not.toBeNull();

    // `task/updated:completed` is the real terminal signal for a
    // spawn_only tool: the supervisor task settled, so the chip
    // flips to `complete` and the row shows the static check.
    act(() => {
      handleTaskUpdated(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          task_id: "tc-x",
          tool_call_id: "tc-x",
          state: "completed",
          tool_name: "run_pipeline",
        },
      );
    });
    const rowAfterTaskCompleted = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(rowAfterTaskCompleted).not.toBeNull();
    expect(rowAfterTaskCompleted!.textContent).toContain("10s elapsed");
    expect(rowAfterTaskCompleted!.getAttribute("data-tool-status")).toBe(
      "complete",
    );
    expect(
      rowAfterTaskCompleted!.querySelector(
        "[data-testid='tool-progress-spinner']",
      ),
    ).toBeNull();
    expect(
      rowAfterTaskCompleted!.querySelector(
        "[data-testid='tool-progress-complete-icon']",
      ),
    ).not.toBeNull();

    harness.unmount();
  });

  it("shows the animated spinner mid-turn (before turn/completed sweeps the in-flight calls)", () => {
    // Anchor for the live-spinner-on-running case: BEFORE the
    // foreground LLM turn settles, the tool call is still
    // `status: "running"`, so the indicator must surface an
    // animated `Loader2`. This complements the post-completion test
    // above where `finalizeAssistant` sweeps to `complete` and the
    // icon goes static.
    const cmid = "turn-midflight";
    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "midflight",
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
          tool_call_id: "tc-mid",
          tool_name: "run_pipeline",
        },
      );
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: "tc-mid",
          message: "plan_and_search 5s elapsed",
        },
      );
    });

    // NO turn/completed yet — call is still `running`.
    const row = harness.container.querySelector(
      "[data-testid='tool-progress']",
    );
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-tool-status")).toBe("running");
    expect(
      row!.querySelector("[data-testid='tool-progress-spinner']"),
    ).not.toBeNull();
    expect(
      row!.querySelector("[data-testid='tool-progress-complete-icon']"),
    ).toBeNull();

    harness.unmount();
  });

  it("ignores crew:tool_progress events scoped to a different session", () => {
    // No bubble yet — the chat is in its empty state. Pre-fix the
    // chat-layout-level mount would have surfaced the spinner row in
    // the empty state; per-bubble there's nothing to attach to, so
    // the row is correctly absent regardless of session scope.
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
            turnId: "unrelated-turn",
          },
        }),
      );
    });
    expect(
      harness.container.querySelector("[data-testid='tool-progress']"),
    ).toBeNull();
    harness.unmount();
  });

  it("does not surface a different bubble's tool progress inside this bubble", () => {
    // Two concurrent threads (A and B) — each has its own bubble. A
    // heartbeat for thread A's tool call MUST NOT light up thread B's
    // bubble spinner. The new per-bubble indicator is a pure
    // derivation of its own `message.toolCalls`, so cross-bubble
    // isolation is structural — A's progress entries land only on
    // A's bubble's `toolCalls` (routed by `tool_call_id` /
    // `turn_id` at the store level), and B's indicator never sees
    // them at all.
    const cmidA = "turn-A";
    const cmidB = "turn-B";
    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "A",
        clientMessageId: cmidA,
      });
      ThreadStore.addUserMessage(SESSION, {
        text: "B",
        clientMessageId: cmidB,
      });
    });

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    // Both threads start a run_pipeline-style tool.
    act(() => {
      handleTurnStarted(
        { sessionId: SESSION },
        { session_id: SESSION, turn_id: cmidA },
      );
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmidA,
          tool_call_id: "tc-A",
          tool_name: "run_pipeline",
        },
      );
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmidA,
          tool_call_id: "tc-A",
          message: "A starting",
        },
      );
      handleTurnCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmidA,
          message_id: "m-A",
          persisted_at: new Date().toISOString(),
        },
      );

      handleTurnStarted(
        { sessionId: SESSION },
        { session_id: SESSION, turn_id: cmidB },
      );
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmidB,
          tool_call_id: "tc-B",
          tool_name: "run_pipeline",
        },
      );
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmidB,
          tool_call_id: "tc-B",
          message: "B starting",
        },
      );
      handleTurnCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmidB,
          message_id: "m-B",
          persisted_at: new Date().toISOString(),
        },
      );
    });

    // Now an A-only heartbeat: only A's spinner row should pick it up.
    act(() => {
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmidA,
          tool_call_id: "tc-A",
          message: "A unique heartbeat at 30s",
        },
      );
    });

    const rows = harness.container.querySelectorAll(
      "[data-testid='tool-progress']",
    );
    expect(rows.length).toBeGreaterThan(0);
    let aRowWithHeartbeat: Element | null = null;
    let bRowWithStaleMessage: Element | null = null;
    for (const row of rows) {
      const bubble = row.closest("[data-testid='assistant-message']");
      if (!bubble) continue;
      const tid = bubble.getAttribute("data-thread-id");
      if (tid === cmidA && (row.textContent ?? "").includes("30s")) {
        aRowWithHeartbeat = row;
      }
      if (
        tid === cmidB &&
        ((row.textContent ?? "").includes("starting") ||
          !(row.textContent ?? "").includes("30s"))
      ) {
        bRowWithStaleMessage = row;
      }
    }
    expect(aRowWithHeartbeat).not.toBeNull();
    // B's row must NOT have picked up A's heartbeat.
    expect(bRowWithStaleMessage).not.toBeNull();
    expect(bRowWithStaleMessage!.textContent).not.toContain("30s");

    harness.unmount();
  });
});
