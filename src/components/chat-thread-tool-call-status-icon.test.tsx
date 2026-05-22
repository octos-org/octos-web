/**
 * Per-tool status icon inside `ToolCallBubble` (2026-05-14 follow-up).
 *
 * Sibling fix to `586ce04` which gated `ToolProgressIndicator`'s leading
 * icon by the owning tool call's `status`. That fix only covered the
 * indicator rendered just above the message footer ("[icon] tool: msg")
 * — the per-tool card rendered inside the assistant bubble
 * (`ToolCallBubble`) had NO leading status icon at all, and the only
 * visual signal for "in-flight" was the wrapper's `animate-pulse`
 * (Tailwind opacity pulse) which the user perceived as a stuck
 * spinner: for a `fm_tts` spawn_only call, the bubble surfaced the
 * literal progress message `fm_tts: completed` while the wrapper kept
 * pulsing because nothing tied the leading affordance to
 * `toolCall.status`.
 *
 * What this file pins:
 *
 *   1. `status === "running"`  → animated `Loader2` is mounted next to
 *      the tool name (`data-testid='tool-call-status-spinner'`), AND
 *      the Check / X icons are absent.
 *
 *   2. `status === "complete"` → static `Check`
 *      (`data-testid='tool-call-status-complete-icon'`); spinner gone.
 *
 *   3. `status === "error"`    → static `X`
 *      (`data-testid='tool-call-status-error-icon'`); spinner gone.
 *
 *   4. Spawn_only end-to-end (`fm_tts`): a `tool/completed` event
 *      (the foreground leg of a spawn_only tool) flips the bubble's
 *      status to `complete` and the leading icon transitions from
 *      `Loader2` → static `Check` even while later background
 *      heartbeats keep landing on the same call's `progress[]`.
 *
 * The store mutations (`setToolCallStatus`, `finalizeAssistant`,
 * `appendToolProgress`) are EXISTING and out of scope for this fix —
 * only the bubble's render of `toolCall.status` is touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const SESSION = "sess-tool-call-status-icon";

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
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
  __resetRouterStateForTest();
  __resetTurnMetaForTest();
});

describe("ToolCallBubble leading status icon", () => {
  it("renders the animated Loader2 spinner when toolCall.status is 'running'", () => {
    const cmid = "turn-running";
    const toolCallId = "tc-running";
    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "kick off",
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
          tool_call_id: toolCallId,
          tool_name: "fm_tts",
        },
      );
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          message: "starting",
        },
      );
    });

    const bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-tool-status")).toBe("running");

    // Running ⇒ animated Loader2 visible; Check + X absent.
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).not.toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-complete-icon']"),
    ).toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-error-icon']"),
    ).toBeNull();

    harness.unmount();
  });

  it("renders the static Check when toolCall.status is 'complete'", () => {
    // Drive a synthetic complete state via a non-spawn_only tool
    // (`shell`) so the foreground `tool/completed` flips status to
    // "complete" the moment it lands. For spawn_only tools (fm_tts /
    // podcast_generate / run_pipeline / etc.) the foreground envelope
    // is only an ack — defect A defers the terminal flip until
    // `task/updated:completed`. This test pins the non-spawn_only
    // happy path; the spawn_only terminal transition is covered in
    // ui-protocol-event-router.test.ts via `task/updated:completed`.
    const cmid = "turn-complete";
    const toolCallId = "tc-complete";
    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "complete",
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
          tool_call_id: toolCallId,
          tool_name: "shell",
        },
      );
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          message: "completed",
        },
      );
      handleToolCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          tool_name: "shell",
          success: true,
        },
      );
    });

    const bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-tool-status")).toBe("complete");

    // Complete ⇒ static Check; spinner + error icons absent.
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-complete-icon']"),
    ).not.toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-error-icon']"),
    ).toBeNull();

    harness.unmount();
  });

  it("renders the static X when toolCall.status is 'error'", () => {
    const cmid = "turn-error";
    const toolCallId = "tc-error";
    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "error",
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
          tool_call_id: toolCallId,
          tool_name: "fm_tts",
        },
      );
      handleToolCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          tool_name: "fm_tts",
          success: false,
        },
      );
    });

    const bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-tool-status")).toBe("error");

    // Error ⇒ static X; spinner + Check absent.
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-complete-icon']"),
    ).toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-error-icon']"),
    ).not.toBeNull();

    harness.unmount();
  });

  it("defers a spawn_only fm_tts terminal until task/updated:completed (defect A, 2026-05-22)", () => {
    // Defect A (M9 follow-up): the foreground `tool/completed`
    // envelope for a spawn_only tool (fm_tts here, also covers
    // podcast_generate / run_pipeline / mofa_* / voice_synthesize /
    // deep_search) fires ~2ms after `tool/started` — it's only the
    // supervisor acknowledgement. Pre-fix the chip flipped to
    // "complete" the moment that envelope landed, planting a static
    // Check on a card whose work was still running. Post-fix the
    // chip stays "running" through every foreground `tool/completed`
    // + late progress heartbeat, and finally settles when the real
    // `task/updated:completed` arrives.
    const cmid = "turn-fm-tts-spawnonly";
    const toolCallId = "tc-fm-tts";
    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "synthesise voice over",
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
          tool_call_id: toolCallId,
          tool_name: "fm_tts",
        },
      );
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          message: "synthesising",
        },
      );
    });

    // Pre-completion: the bubble pulses + spinner is mounted.
    let bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-tool-status")).toBe("running");
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).not.toBeNull();

    // Foreground `tool/completed` arrives (spawn_only's synchronous
    // ack leg). Post-defect-A: status DOES NOT flip — the real
    // terminal signal is `task/updated:completed`, which lands once
    // the background task actually finishes.
    act(() => {
      handleToolCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          tool_name: "fm_tts",
          success: true,
        },
      );
    });

    bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-tool-status")).toBe("running");
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).not.toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-complete-icon']"),
    ).toBeNull();

    // A late background heartbeat lands while the supervisor task is
    // still running — chip stays in "running".
    act(() => {
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          message: "background flush, 30s elapsed",
        },
      );
    });

    bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-tool-status")).toBe("running");

    // Finally `task/updated:completed` lands — the real terminal
    // signal. The chip flips to "complete" and the spinner clears.
    act(() => {
      handleTaskUpdated(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          task_id: toolCallId,
          tool_call_id: toolCallId,
          state: "completed",
          tool_name: "fm_tts",
        },
      );
    });

    bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-tool-status")).toBe("complete");
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-complete-icon']"),
    ).not.toBeNull();

    harness.unmount();
  });

  it("keeps the run_pipeline spinner alive after turn/completed (codex PR #147 BLOCKER, 2026-05-22)", () => {
    // Original assertion: "turn/completed sweeps the in-flight tool
    // call to `complete`; the leading icon flips from spinner to
    // Check". That sweep was the second code path Defect A's
    // foreground fix missed — for spawn_only tools the background
    // task runs minutes after `turn/completed` lands.
    //
    // Post-codex-fix: `finalizeAssistant`'s sweep is gated by
    // `SPAWN_ONLY_TOOL_NAMES`. `run_pipeline` is in the set, so the
    // chip stays in `running` past `turn/completed`. The real
    // terminal flip comes from `handleTaskUpdated:completed`.
    //
    // Test order: spinner present at start → spinner STILL present
    // after `turn/completed` → spinner clears + Check appears only
    // after `task/updated:completed`.
    const cmid = "turn-run-pipeline";
    const toolCallId = "tc-run-pipeline";
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
          tool_call_id: toolCallId,
          tool_name: "run_pipeline",
        },
      );
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          message: "Pipeline 'cerebras_research' running: plan_and_search",
        },
      );
    });

    let bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble!.getAttribute("data-tool-status")).toBe("running");
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).not.toBeNull();

    // turn/completed lands — sweep is now gated; spawn_only chip stays.
    act(() => {
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

    bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-tool-status")).toBe("running");
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).not.toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-complete-icon']"),
    ).toBeNull();

    // `task/updated:completed` lands — supervisor reports background
    // work is done. The chip finally flips to `complete`.
    act(() => {
      handleTaskUpdated(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          task_id: toolCallId,
          tool_call_id: toolCallId,
          state: "completed",
          tool_name: "run_pipeline",
        },
      );
    });

    bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    expect(bubble!.getAttribute("data-tool-status")).toBe("complete");
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-complete-icon']"),
    ).not.toBeNull();

    harness.unmount();
  });
});
