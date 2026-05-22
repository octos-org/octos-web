/**
 * Stuck-spinner regression: when a spawn_only tool (`podcast_generate`)
 * completes successfully, NO animating element may remain visible
 * inside the assistant bubble alongside the "tool: completed" status.
 *
 * Bug observed live on mini5 (2026-05-15): user reported that even
 * though both the per-tool leading icon (commit f8717fc) and the
 * `ToolProgressIndicator` leading icon (commit 586ce04) had been
 * gated on `toolCall.status` — and the wrapper `animate-pulse` at
 * chat-thread.tsx:593-599 was also gated correctly — a spinner was
 * STILL visibly animating right next to the chip text reading
 * "podcast_generate: completed". The spinner sat inside the bubble.
 *
 * Empirical probe of the rendered DOM identified the offending
 * render: the three streaming-text placeholder dots at
 * `chat-thread.tsx:741-747` that render when
 * `isStreaming && !message.text`. For a spawn_only flow the
 * foreground `tool/completed` lands immediately, but the parent LLM
 * turn keeps streaming (the LLM is preparing its post-tool text, or
 * may simply not emit any text before `turn/completed`). In that
 * window:
 *
 *   - `isStreaming === true` (pendingAssistant.status === "streaming")
 *   - `message.text === ""` (LLM hasn't sent text yet)
 *   - the bubble's ToolCallBubble has `status === "complete"`
 *   - the bubble's ToolProgressIndicator shows
 *     "podcast_generate: completed" with a static Check
 *
 * → three `animate-pulse` dots render above the tool calls, visually
 * indistinguishable from a stuck spinner, inside the same assistant
 * card the user identifies as "the podcast_generate bubble".
 *
 * Fix: the streaming-dots placeholder is for the case where the
 * assistant is producing text and we don't have anything else to show.
 * When the bubble already hosts at least one tool call, the tool
 * call's own status icon (running/complete/error) is the unambiguous
 * liveness indicator — the dots are redundant and, when any tool
 * call has already settled to a terminal state, actively misleading.
 * Gate the dots on "the bubble has no tool calls yet". Status-aware,
 * matching the predicate shape of commits f8717fc and 586ce04.
 *
 * This file pins the post-fix invariant: with status === "complete"
 * (`tool/completed` already fired, `turn/completed` has NOT) the
 * assistant card must contain zero animating descendants associated
 * with the bubble for that tool call.
 *
 * Existing sibling tests this complements (do not regress):
 *   - chat-thread-tool-call-status-icon.test.tsx
 *   - tool-progress-indicator.test.tsx
 *   - chat-thread-bg-spinner.test.tsx
 *   - chat-thread-progress-toggle.test.tsx
 *   - chat-thread-heartbeat.test.tsx
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
  handleToolCompleted,
  handleToolProgress,
  handleToolStarted,
  handleTurnCompleted,
  handleTurnStarted,
} from "@/runtime/ui-protocol-event-router";

const SESSION = "sess-no-trailing-spinner";

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

describe("ToolCallBubble — no trailing spinner after terminal status", () => {
  it("keeps the spawn_only spinner alive after foreground tool/completed until task/updated terminal (defect A, 2026-05-22)", () => {
    // Defect A (M9 follow-up): the foreground `tool/completed`
    // envelope for a spawn_only tool (`podcast_generate`,
    // `run_pipeline`, etc.) fires ~2ms after `tool/started` — it's
    // only the supervisor's acknowledgement, the background work is
    // still in flight. Pre-fix the bubble settled to "complete" the
    // moment foreground completion landed, planting a static Check on
    // a tool card whose work was still running for minutes. Post-fix
    // the chip stays "running" until `task/updated:completed` (the
    // real terminal signal) arrives — verified in a separate test in
    // ui-protocol-event-router.test.ts; this test pins the bubble
    // rendering invariant.
    const cmid = "turn-podcast-mid-stream";
    const toolCallId = "tc-podcast";

    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "generate a podcast",
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
          tool_name: "podcast_generate",
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
      // Foreground `tool/completed` arrives → status flips to "complete".
      handleToolCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          tool_name: "podcast_generate",
          success: true,
        },
      );
      // Late BG heartbeat lands AFTER terminal — typical for
      // spawn_only. The progress message contains the literal text
      // "completed" (mirroring the live mini5 log where the chip
      // text was "podcast_generate: completed" while a spinner kept
      // animating beside it).
      handleToolProgress(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          message: "completed",
        },
      );
      // DELIBERATELY do NOT fire `handleTurnCompleted` yet — this is
      // the in-flight window the bug surfaces in.
    });

    // Post-defect-A: the bubble must NOT have flipped to "complete"
    // off the foreground `tool/completed`. The chip stays "running"
    // and the running affordance (the three-ball spinner that
    // replaced the legacy Loader2) is still mounted under the same
    // `data-testid` the spec uses to find it.
    const bubble = harness.container.querySelector(
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
    // The legacy `Loader2` rotation (Tailwind `animate-spin`) has been
    // retired in favour of the three-ball CSS keyframe `tool-ball` —
    // the umbrella "no orphan SVG spinner" invariant still holds.
    expect(bubble!.querySelector(".animate-spin")).toBeNull();

    const assistant = harness.container.querySelector(
      "[data-testid='assistant-message']",
    );
    expect(assistant).not.toBeNull();
    expect(assistant!.querySelector(".animate-spin")).toBeNull();
  });

  it("keeps the spawn_only chip in `running` after turn/completed (codex PR #147 BLOCKER, 2026-05-22)", () => {
    // The original assertion ("after both tool/completed AND
    // turn/completed → chip flips to complete") was the second code
    // path Defect A's foreground fix missed: `finalizeAssistant`'s
    // sweep over `pendingAssistant.toolCalls` flipped EVERY in-flight
    // call to `complete` when `turn/completed` landed, regardless of
    // whether the work was actually done. For a spawn_only tool the
    // real background task runs minutes after `turn/completed` —
    // sweeping the chip silently undid the Defect A deferral.
    //
    // Post-codex-fix: the sweep is gated by `SPAWN_ONLY_TOOL_NAMES`.
    // The chip stays in `running` after `turn/completed`; the real
    // terminal signal is `task/updated:completed`, handled by
    // `handleTaskUpdated`. The non-spawn_only path is covered by a
    // separate test (see "non-spawn_only tools still settle on the
    // turn/completed sweep" below).
    const cmid = "turn-podcast-final";
    const toolCallId = "tc-podcast-final";

    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "generate a podcast",
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
          tool_name: "podcast_generate",
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
      handleToolCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: toolCallId,
          tool_name: "podcast_generate",
          success: true,
        },
      );
      handleTurnCompleted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          message_id: "msg-podcast",
          persisted_at: new Date().toISOString(),
        },
      );
    });

    const bubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(bubble).not.toBeNull();
    // The chip is still in `running` — the spawn_only background work
    // hasn't reported completion via `task/updated` yet.
    expect(bubble!.getAttribute("data-tool-status")).toBe("running");
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-spinner']"),
    ).not.toBeNull();
    expect(
      bubble!.querySelector("[data-testid='tool-call-status-complete-icon']"),
    ).toBeNull();
    // Umbrella "no legacy SVG spinner" invariant still holds —
    // `animate-spin` belonged to the retired `Loader2` shape.
    expect(bubble!.querySelector(".animate-spin")).toBeNull();
  });

  it("still shows the streaming-text placeholder dots when there are NO tool calls (no regression for plain text turns)", () => {
    // Regression guard: the streaming-dots gate must still allow
    // dots to render when the assistant is streaming a plain text
    // response with NO tool calls. Without this guard the fix would
    // silently disable the "thinking" affordance on every text-only
    // turn.
    const cmid = "turn-text-only";

    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "hi",
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
    });

    const assistant = harness.container.querySelector(
      "[data-testid='assistant-message']",
    );
    expect(assistant).not.toBeNull();
    // No tool calls → dots are the only liveness affordance.
    expect(assistant!.querySelector("[data-testid='tool-call-bubble']")).toBeNull();
    // The three streaming-placeholder dots ARE allowed here.
    expect(assistant!.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});
