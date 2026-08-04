import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatThread } from "./chat-thread";
import {
  SessionContext,
  type SessionContextValue,
} from "@/runtime/session-context";
import type {
  ProjectionEnvelopeV2,
  ProjectionEnvelopeV2Payload,
} from "@/runtime/projection-envelope-v2";
import * as ProjectionStore from "@/store/projection-store";
import { __resetProjectionRenderAdapterForTests } from "@/store/projection-render-adapter";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "sess-chat-projection";
const THREAD = "thread-chat-projection";
const TURN = "turn-chat-projection";
const CMID = "cmid-chat-projection";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function contextValue(): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: SESSION,
    historyTopic: undefined,
    currentSessionTitle: "",
    currentSessionStats: null,
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

function envelope(
  seq: number,
  payload: ProjectionEnvelopeV2Payload,
): ProjectionEnvelopeV2 {
  return {
    session_id: SESSION,
    thread_id: THREAD,
    turn_id: TURN,
    seq,
    cursor: { stream: SESSION, seq },
    ...(seq === 1 ? { client_message_id: CMID } : {}),
    payload,
  };
}

function mount(): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SessionContext.Provider value={contextValue()}>
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

function ingest(...frames: ProjectionEnvelopeV2[]): void {
  const key = ProjectionStore.projectionStoreKey(SESSION);
  act(() => {
    for (const frame of frames) ProjectionStore.ingest(key, frame);
  });
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  ProjectionStore.__resetProjectionForTests();
  __resetProjectionRenderAdapterForTests();
});

describe("ChatThread canonical projection rendering", () => {
  it("renders an assistant persisted segment exactly once", () => {
    ingest(
      envelope(1, {
        type: "user_message",
        data: { text: "Canonical question", files: [] },
      }),
      envelope(2, {
        type: "assistant_persisted",
        data: {
          assistant_segment_id: "segment-answer",
          text: "Canonical answer",
          meta: {
            message_id: "message-answer",
            persisted_at: "2026-07-19T00:00:00Z",
          },
        },
      }),
      envelope(3, {
        type: "turn_terminal",
        data: { outcome: "completed" },
      }),
    );

    const harness = mount();
    try {
      const assistants = harness.container.querySelectorAll(
        "[data-testid='assistant-message']",
      );
      expect(assistants).toHaveLength(1);
      expect(assistants[0]?.textContent).toContain("Canonical answer");
      expect(harness.container.textContent).toContain("Canonical question");
    } finally {
      harness.unmount();
    }
  });

  it("renders a canonical tool call with its arguments, progress, and terminal status", () => {
    ingest(
      envelope(1, {
        type: "user_message",
        data: { text: "Run the canonical tool", files: [] },
      }),
      envelope(2, {
        type: "assistant_delta",
        data: { assistant_segment_id: "segment-tool", text: "" },
      }),
      envelope(3, {
        type: "tool_start",
        data: {
          tool_call_id: "tool-canonical",
          name: "shell",
          arguments: { command: "npm run test:unit" },
        },
      }),
      envelope(4, {
        type: "tool_progress",
        data: { tool_call_id: "tool-canonical", message: "Running tests" },
      }),
      envelope(5, {
        type: "tool_end",
        data: { tool_call_id: "tool-canonical", status: "complete" },
      }),
      envelope(6, {
        type: "assistant_persisted",
        data: {
          assistant_segment_id: "segment-tool",
          text: "The canonical tool finished.",
          meta: {
            message_id: "message-tool",
            persisted_at: "2026-07-19T00:00:01Z",
          },
        },
      }),
      envelope(7, {
        type: "turn_terminal",
        data: { outcome: "completed" },
      }),
    );

    const harness = mount();
    try {
      const bubble = harness.container.querySelector(
        "[data-testid='tool-call-bubble']",
      );
      expect(bubble).not.toBeNull();
      expect(bubble?.getAttribute("data-tool-status")).toBe("complete");
      expect(
        bubble?.querySelector("[data-testid='tool-call-status-complete-icon']"),
      ).not.toBeNull();
      expect(bubble?.textContent).toContain("command:");
      expect(bubble?.textContent).toContain("npm run test:unit");
      expect(bubble?.textContent).toContain("Running tests");
    } finally {
      harness.unmount();
    }
  });
});
