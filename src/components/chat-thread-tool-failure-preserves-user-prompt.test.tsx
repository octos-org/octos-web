/**
 * Spawn-only tool failure must NOT make the user's originating prompt
 * disappear from the chat history.
 *
 * Bug repro (2026-05-14, mini5): user asked the agent to generate a
 * podcast. The `podcast_generate` spawn_only background task ran to
 * completion (exit 0) but the workspace contract validator rejected the
 * result (`magic_bytes: no files matched 'skill-output/mofa-podcast/*.mp3'`),
 * so the server emitted a failure notification. The chat then rendered
 * "✗ podcast_generate failed: …" but the user's original prompt
 * ("Please generate a podcast …") VANISHED from the visible chat
 * history.
 *
 * Root cause (see `appendCompletionBubble` in `thread-store.ts`): when
 * `event.thread_id` on a `turn/spawn_complete` envelope doesn't match
 * any existing thread in the store (a `findThreadById` miss), the
 * fallback creates a NEW orphan thread with `placeholderUser.text = ""`.
 * The renderer's `UserBubbleShell` hides empty-text bubbles entirely
 * (`text === ""` collapses the card to just a timestamp). The failure
 * message lands in the orphan thread; the user's REAL thread (keyed on
 * the original cmid) sits in a different bundle. The user perceives
 * the prompt as "vanished" next to the failure bubble — visually
 * disjointed: one bubble bundle with the prompt and nothing else, then
 * a different bubble bundle with only the failure text.
 *
 * The hard-refresh replay shape this bug surfaces under has nothing to
 * do with `b3769ae`'s `isVisibleResponse` (which only filters
 * ASSISTANT rows). The orphan-placeholder issue lives entirely in the
 * `appendCompletionBubble` resolution path.
 *
 * This test mounts the real `ChatThread`, drives the spawn-only
 * failure flow end-to-end, and asserts that wherever the failure
 * bubble lands, it lands in the SAME thread bundle as the user
 * prompt.
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
  handleSpawnComplete,
  handleToolCompleted,
  handleToolStarted,
  handleTurnCompleted,
  handleTurnStarted,
} from "@/runtime/ui-protocol-event-router";

const SESSION = "sess-tool-failure";

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

function findBundleByContent(
  container: HTMLElement,
  needle: string,
): Element | null {
  for (const bundle of container.querySelectorAll(
    "[data-testid='chat-thread-bundle']",
  )) {
    if ((bundle.textContent ?? "").includes(needle)) return bundle;
  }
  return null;
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
  __resetRouterStateForTest();
  __resetTurnMetaForTest();
});

describe("spawn_only tool failure preserves user prompt", () => {
  it("LIVE wire: workspace-contract rejection on podcast_generate keeps the user prompt in the same thread bundle", () => {
    // The user prompt that triggered the failing tool.
    const userPrompt =
      "Please generate a podcast for last week's research notes.";
    const cmid = "cmid-podcast-failed";
    const taskId = "task-podcast-1";
    const toolCallId = "tc-podcast-1";

    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: userPrompt,
        clientMessageId: cmid,
      });
    });

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    // Drive the live wire: turn/started → tool/started →
    // tool/completed (spawn dispatch ok) → turn/completed.
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
        { session_id: SESSION, turn_id: cmid },
      );
    });

    // Workspace contract rejects: a `turn/spawn_complete` envelope
    // delivers the failure notification.
    act(() => {
      handleSpawnComplete(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          thread_id: cmid,
          task_id: taskId,
          response_to_client_message_id: cmid,
          seq: 99,
          message_id: "msg-failure",
          source: "background",
          cursor: { stream: SESSION, seq: 0 },
          persisted_at: new Date().toISOString(),
          content:
            "✗ podcast_generate failed: required validator failure: podcast_generate.on_completion[0]: magic_bytes: no files matched 'skill-output/mofa-podcast/*.mp3'",
        },
      );
    });

    // The failure message + the user prompt MUST share a single thread
    // bundle. If they end up in separate bundles, the user sees the
    // failure as "orphaned" — the prompt looks like it vanished.
    const failureBundle = findBundleByContent(
      harness.container,
      "podcast_generate failed",
    );
    expect(failureBundle).not.toBeNull();
    const userMsgInBundle = failureBundle!.querySelector(
      "[data-testid='user-message']",
    );
    expect(userMsgInBundle?.textContent ?? "").toContain(userPrompt);

    harness.unmount();
  });

  it("LIVE wire (orphan-thread defence): a spawn_complete whose thread_id misses every known thread MUST attribute to the most recent thread, not mint a new empty-user-placeholder orphan", () => {
    // Defence-in-depth: the SERVER's `bg_thread_id = turn_id.0.to_string()`
    // and the SPA's `bridge.sendTurn(cmid, ...)` set `params.turn_id =
    // cmid`. In a healthy round-trip the two match. But the field has
    // round-tripped through a stringified UUID under different
    // serialisers across releases, and any client-side / server-side
    // bookkeeping bug that lets the two diverge (or that produces a
    // late event after the SPA already forgot the cmid via a reload)
    // surfaces here.
    //
    // The pre-fix behaviour produced an orphan thread with an empty
    // user placeholder, hosting only the failure bubble. The user's
    // REAL thread (with the original prompt) lived in a separate
    // bundle — so the chat scroll showed prompt-bundle / orphan-with-
    // failure-bundle side by side, with the orphan looking like
    // "headless" assistant text. The fix: when `appendCompletionBubble`
    // can't find a host thread but the active session has exactly one
    // thread (or one most-recent thread), attribute the bubble there.
    const userPrompt = "kick off the podcast generation";
    const userCmid = "cmid-user-prompt";
    const orphanTurnId = "01928af6-12fa-7a30-aaaa-bbbbccccdddd";

    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: userPrompt,
        clientMessageId: userCmid,
      });
    });

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    act(() => {
      // The failure spawn_complete's thread_id does NOT match the
      // user's cmid. The SPA must NOT silently orphan the failure
      // bubble into a brand-new empty-user thread.
      handleSpawnComplete(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: orphanTurnId,
          thread_id: orphanTurnId,
          task_id: "task-orphan-1",
          response_to_client_message_id: undefined,
          seq: 99,
          message_id: "msg-fail",
          source: "background",
          cursor: { stream: SESSION, seq: 0 },
          persisted_at: new Date().toISOString(),
          content: "✗ podcast_generate failed: validator rejected output",
        },
      );
    });

    // The failure bubble landed somewhere.
    const allText = Array.from(
      harness.container.querySelectorAll(
        "[data-testid='assistant-message']",
      ),
    )
      .map((b) => b.textContent ?? "")
      .join(" | ");
    expect(allText).toContain("podcast_generate failed");

    // The failure bubble's thread bundle MUST contain the user prompt.
    const failureBundle = findBundleByContent(
      harness.container,
      "podcast_generate failed",
    );
    expect(failureBundle).not.toBeNull();
    const userMsgInBundle = failureBundle!.querySelector(
      "[data-testid='user-message']",
    );
    expect(userMsgInBundle?.textContent ?? "").toContain(userPrompt);

    harness.unmount();
  });

  it("REFRESH hydrate: a session whose last spawn_only run failed still shows the user prompt + failure message in the same bundle", () => {
    // After hard refresh, the JSONL ledger replay shape is:
    //   seq 0: user — "Please generate a podcast …"
    //   seq 1: assistant — metadata-only (tool_calls=[podcast_generate],
    //          REST strips tool_calls so content="")
    //   seq 2: tool — "Started 'podcast_generate' in background."
    //   seq 3: assistant — "✗ podcast_generate failed: required
    //                       validator failure: …"  (Background source)
    const userPrompt =
      "Please generate a podcast for last week's research notes.";
    const cmid = "cmid-podcast-failed-refresh";
    act(() => {
      ThreadStore.replayHistory(SESSION, [
        {
          seq: 0,
          role: "user",
          content: userPrompt,
          client_message_id: cmid,
          thread_id: cmid,
          timestamp: "2026-05-14T05:29:30Z",
        },
        {
          seq: 1,
          role: "assistant",
          content: "",
          response_to_client_message_id: cmid,
          thread_id: cmid,
          timestamp: "2026-05-14T05:29:38Z",
        },
        {
          seq: 2,
          role: "tool",
          content: "Started 'podcast_generate' in background.",
          thread_id: cmid,
          timestamp: "2026-05-14T05:29:38Z",
        },
        {
          seq: 3,
          role: "assistant",
          content:
            "✗ podcast_generate failed: required validator failure: podcast_generate.on_completion[0]: magic_bytes: no files matched 'skill-output/mofa-podcast/*.mp3'",
          response_to_client_message_id: cmid,
          thread_id: cmid,
          timestamp: "2026-05-14T05:32:21Z",
        },
      ]);
    });

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    const failureBundle = findBundleByContent(
      harness.container,
      "podcast_generate failed",
    );
    expect(failureBundle).not.toBeNull();
    const userMsgInBundle = failureBundle!.querySelector(
      "[data-testid='user-message']",
    );
    expect(userMsgInBundle?.textContent ?? "").toContain(userPrompt);

    harness.unmount();
  });
});
