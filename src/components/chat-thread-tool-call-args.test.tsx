import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { ChatThread } from "./chat-thread";
import { SessionContext, type SessionContextValue } from "@/runtime/session-context";
import * as ThreadStore from "@/store/thread-store";
import {
  __resetRouterStateForTest,
  __resetTurnMetaForTest,
  handleToolStarted,
  handleTurnStarted,
} from "@/runtime/ui-protocol-event-router";

const SESSION = "sess-tool-call-args";

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

function mount(): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SessionContext.Provider value={makeSessionCtx()}>
        <ChatThread />
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

const CASES = [
  {
    name: "shell",
    args: { command: "cargo test -p octos-web" },
    kind: "command",
    value: "cargo test -p octos-web",
  },
  {
    name: "read_file",
    args: { path: "src/slides/components/slides-chat.tsx" },
    kind: "path",
    value: "src/slides/components/slides-chat.tsx",
  },
  {
    name: "deep_search",
    args: { query: "octos web bridge events" },
    kind: "query",
    value: "octos web bridge events",
  },
] as const;

describe("ToolCallBubble argument summaries", () => {
  it.each(CASES)("renders $kind for $name tool calls", ({ args, kind, name, value }) => {
    const cmid = `turn-${kind}`;
    const toolCallId = `tc-${kind}`;
    act(() => {
      ThreadStore.addUserMessage(SESSION, {
        text: "run tool",
        clientMessageId: cmid,
      });
    });

    const harness = mount();
    try {
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
            tool_name: name,
            arguments: args,
          },
        );
      });

      const argsNode = harness.container.querySelector(
        "[data-testid='tool-call-args']",
      );
      expect(argsNode).not.toBeNull();
      expect(argsNode!.getAttribute("data-tool-call-args-kind")).toBe(kind);
      expect(argsNode!.textContent).toContain(`${kind}:`);
      expect(argsNode!.textContent).toContain(value);
    } finally {
      harness.unmount();
    }
  });
});
