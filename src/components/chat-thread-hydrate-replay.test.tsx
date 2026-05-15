/**
 * Hard-refresh replay regression — verifies that a previously-completed
 * `run_pipeline` (spawn_only) bubble does NOT render as an empty
 * timestamp-only shell after the SPA rehydrates from the server ledger.
 *
 * Bug repro (2026-05-14): after the stack
 *   1a20b7a — React.memo immutable updates
 *   b89faee — collapsible chip-list toggle
 *   e8cfb94 — re-anchored tool-progress spinner
 *   586ce04 — spinner gated on toolCall.status
 * landed, hard-refreshing the SPA on a session whose live state had a
 * finalised `run_pipeline` bubble produced an empty bubble (just the
 * timestamp) — no tool name, no chips, no completion icon.
 *
 * Root cause: the server's agent loop persists one Assistant row per
 * LLM iteration. For a spawn_only tool like `run_pipeline` the first
 * iteration commits an Assistant `Message { content: "", tool_calls:
 * [run_pipeline], media: [] }` followed by a `Tool` row carrying the
 * "started in background" result, then (sometimes) a final Assistant
 * row with a text confirmation. The server-side wire filter
 * `is_metadata_only_assistant_row` suppresses the metadata-only
 * Assistant row from the LIVE `message/persisted` envelope stream, so
 * during a live session it never reaches the SPA. The legacy REST
 * `session/messages_page` lookup reads JSONL directly with NO such
 * filter — the row is returned and `replayHistory` builds a
 * `ThreadMessage { text: "", toolCalls: [], files: [] }` (the
 * `MessageInfo` REST shape strips `tool_calls`, so even if the SPA
 * wanted to render the tool chip from server data it has nothing to
 * draw with). Rendered: empty timestamp-only bubble.
 *
 * Fix: mirror the server's wire-suppression filter at the SPA hydration
 * boundary. The renderer's `isVisibleResponse` (chat-thread.tsx)
 * already drops `role === "tool"` rows; this regression extends the
 * filter to Assistant rows that have no text, no files, AND no
 * tool-call data (the same "metadata-only" predicate). Live state is
 * not affected — the live wire never carries these rows, and an
 * Assistant bubble that picks up tool-call data via `tool/started` →
 * `addToolCall` always has `toolCalls.length > 0` so the filter doesn't
 * touch it.
 *
 * This file feeds `replayHistory` the exact shape the production
 * `messages_page` endpoint returns for a `run_pipeline` session and
 * mounts the real `ChatThread` to assert the rendered DOM is what the
 * user expects — the user prompt and the final text answer, no empty
 * shell in between.
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
import { __resetRouterStateForTest } from "@/runtime/ui-protocol-event-router";

const SESSION = "sess-hydrate-replay";

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
});

describe("hard-refresh replay for a completed run_pipeline turn", () => {
  it("drops the metadata-only assistant row that the server-side wire filter suppresses", () => {
    // Simulate the JSONL shape `session/messages_page` returns after a
    // hard refresh of a session that ran `run_pipeline`:
    //
    //   seq 0: user prompt
    //   seq 1: assistant — metadata-only (only tool_calls=[run_pipeline],
    //          empty content, no media; the REST `MessageInfo` shape
    //          strips `tool_calls`)
    //   seq 2: tool result (server-side, "Pipeline started in background")
    //   seq 3: assistant — final text reply
    const cmid = "cmid-pipeline";
    act(() => {
      ThreadStore.replayHistory(SESSION, [
        {
          seq: 0,
          role: "user",
          content: "run the cerebras research pipeline",
          client_message_id: cmid,
          thread_id: cmid,
          timestamp: "2026-05-14T10:00:00Z",
        },
        {
          seq: 1,
          role: "assistant",
          // The metadata-only row: tool_calls are dropped from REST
          // payload, content is empty.
          content: "",
          response_to_client_message_id: cmid,
          thread_id: cmid,
          timestamp: "2026-05-14T10:00:01Z",
        },
        {
          seq: 2,
          role: "tool",
          content: "Pipeline 'cerebras_research' started in background.",
          thread_id: cmid,
          timestamp: "2026-05-14T10:00:02Z",
        },
        {
          seq: 3,
          role: "assistant",
          content: "Started the pipeline. I'll deliver results when done.",
          response_to_client_message_id: cmid,
          thread_id: cmid,
          timestamp: "2026-05-14T10:00:03Z",
        },
      ]);
    });

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    // The metadata-only assistant row must NOT render as a visible
    // bubble — the renderer skips it the same way it skips tool rows.
    const visibleAssistantBubbles = harness.container.querySelectorAll(
      "[data-testid='assistant-message']",
    );
    expect(visibleAssistantBubbles.length).toBe(1);
    const onlyAssistant = visibleAssistantBubbles[0];
    expect(onlyAssistant.textContent ?? "").toContain(
      "Started the pipeline. I'll deliver results when done.",
    );

    // Belt-and-braces: there must NOT be an empty-textContent assistant
    // bubble (the symptom the user reported — "empty bubble shell with
    // only the timestamp visible"). Walk every assistant bubble and
    // assert each has at least one non-whitespace character of visible
    // markdown content OR at least one tool-call card OR at least one
    // file attachment. An assistant bubble that fails all three
    // predicates is the empty-bubble regression.
    for (const bubble of visibleAssistantBubbles) {
      const hasText =
        (bubble.querySelector(".prose")?.textContent ?? "").trim().length > 0;
      const hasToolCall =
        bubble.querySelectorAll("[data-testid='tool-call-bubble']").length > 0;
      const hasFile = bubble.querySelectorAll("audio, video, img, a[href]").length > 0;
      expect(hasText || hasToolCall || hasFile).toBe(true);
    }

    harness.unmount();
  });

  it("drops a trailing metadata-only assistant row (LLM stopped after tool_calls with no follow-on text)", () => {
    // Some spawn_only flows commit a SINGLE assistant iteration: the
    // LLM emits `tool_calls=[run_pipeline]` with empty content, the
    // tool returns "started in background", and the LLM does NOT issue
    // a follow-on text message — the user expects the bubble to surface
    // as the spawn_only spinner's host. Pre-fix this rendered a single
    // empty bubble. We still drop the metadata-only row; the user is
    // left with the user prompt only (no phantom empty assistant) and
    // the background completion will eventually arrive as a separate
    // `turn/spawn_complete` envelope to seed the result bubble.
    const cmid = "cmid-pipeline-no-text";
    act(() => {
      ThreadStore.replayHistory(SESSION, [
        {
          seq: 0,
          role: "user",
          content: "kick off the pipeline",
          client_message_id: cmid,
          thread_id: cmid,
          timestamp: "2026-05-14T11:00:00Z",
        },
        {
          seq: 1,
          role: "assistant",
          content: "",
          response_to_client_message_id: cmid,
          thread_id: cmid,
          timestamp: "2026-05-14T11:00:01Z",
        },
        {
          seq: 2,
          role: "tool",
          content: "Pipeline 'cerebras_research' started in background.",
          thread_id: cmid,
          timestamp: "2026-05-14T11:00:02Z",
        },
      ]);
    });

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    // The user bubble survives; the empty assistant row is filtered;
    // the tool row is filtered (was always filtered).
    const visibleAssistantBubbles = harness.container.querySelectorAll(
      "[data-testid='assistant-message']",
    );
    expect(visibleAssistantBubbles.length).toBe(0);

    const userBubble = harness.container.querySelector(
      "[data-testid='user-message']",
    );
    expect(userBubble).not.toBeNull();
    expect(userBubble!.textContent).toContain("kick off the pipeline");

    harness.unmount();
  });

  it("preserves an assistant bubble whose live state has tool-call data (defence: filter only fires when toolCalls is empty)", () => {
    // The hydration filter must NOT touch live bubbles that picked up
    // tool-call data from `tool/started` + `appendToolProgress`. This
    // exercises the same shape `chat-thread-heartbeat.test.tsx` already
    // covers — a finalised bubble with progress chips. The new filter
    // must check `toolCalls.length === 0` as well as empty text + no
    // files, otherwise heartbeat-fix bubbles would regress.
    const cmid = "cmid-with-toolcalls";
    act(() => {
      ThreadStore.replayHistory(SESSION, [
        {
          seq: 0,
          role: "user",
          content: "run pipeline",
          client_message_id: cmid,
          thread_id: cmid,
          timestamp: "2026-05-14T12:00:00Z",
        },
      ]);
      ThreadStore.addToolCall(cmid, "tc-1", "run_pipeline");
      ThreadStore.appendToolProgress(
        cmid,
        "tc-1",
        "Pipeline 'cerebras_research' started (3 nodes)",
      );
    });

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
      </SessionContext.Provider>,
    );

    // The pending assistant bubble carrying the live tool-call must
    // still render — the filter only fires for the empty REST shape,
    // not for live store state with tool-call data.
    const toolCallBubble = harness.container.querySelector(
      "[data-testid='tool-call-bubble']",
    );
    expect(toolCallBubble).not.toBeNull();
    expect(toolCallBubble!.textContent ?? "").toContain("run_pipeline");

    harness.unmount();
  });
});
