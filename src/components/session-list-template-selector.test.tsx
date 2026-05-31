import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const bridgeSendMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/ui-protocol-send", () => ({
  sendMessage: bridgeSendMock,
}));

import { SessionContext, type SessionContextValue } from "@/runtime/session-context";
import {
  persistSessionTemplates,
  SESSION_TEMPLATE_STORAGE_KEY,
  type SessionTemplateRecord,
} from "@/runtime/session-templates";
import { SessionList } from "./session-list";

const SESSION_ID = "web-1777700000000-template";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function makeSessionCtx(
  overrides: Partial<SessionContextValue> = {},
): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: "web-current",
    historyTopic: undefined,
    currentSessionTitle: "Current",
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
    createSession: () => SESSION_ID,
    removeSession: async () => {},
    refreshSessions: async () => {},
    markSessionActive: () => {},
    ...overrides,
  };
}

function mount(ctx: SessionContextValue): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SessionContext.Provider value={ctx}>
        <SessionList />
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

function mountNode(node: React.ReactElement): MountedHarness {
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

function StatefulSessionList({
  createSessionSpy,
  markSessionActive,
  refreshSessions,
}: {
  createSessionSpy: (title?: string) => void;
  markSessionActive: SessionContextValue["markSessionActive"];
  refreshSessions: SessionContextValue["refreshSessions"];
}) {
  const [currentSessionId, setCurrentSessionId] = React.useState("web-current");
  const ctx = makeSessionCtx({
    currentSessionId,
    createSession: (title?: string) => {
      createSessionSpy(title);
      setCurrentSessionId(SESSION_ID);
      return SESSION_ID;
    },
    markSessionActive,
    refreshSessions,
  });

  return (
    <SessionContext.Provider value={ctx}>
      <SessionList />
    </SessionContext.Provider>
  );
}

async function flushReactWork() {
  await act(async () => {
    await Promise.resolve();
  });
}

function click(container: HTMLElement, selector: string) {
  const button = container.querySelector(selector) as HTMLButtonElement | null;
  expect(button).not.toBeNull();
  act(() => button!.click());
}

beforeEach(() => {
  localStorage.clear();
  bridgeSendMock.mockReset();
});

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  localStorage.clear();
});

describe("SessionList template selector", () => {
  it("creates a slides template session and sends the scaffold command", async () => {
    const createSession = vi.fn();
    const markSessionActive = vi.fn();
    const refreshSessions = vi.fn(async () => {});
    const harness = mountNode(
      <StatefulSessionList
        createSessionSpy={createSession}
        markSessionActive={markSessionActive}
        refreshSessions={refreshSessions}
      />,
    );
    try {
      click(harness.container, "[data-testid='new-chat-button']");
      expect(harness.container.textContent).toContain("What can I help with?");

      const slidesButton = [...harness.container.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Slides"),
      ) as HTMLButtonElement;
      expect(slidesButton).not.toBeNull();
      act(() => slidesButton.click());

      const input = harness.container.querySelector("input") as HTMLInputElement;
      expect(input).not.toBeNull();
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "Westlake Project");
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
      const createButton = [...harness.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Create",
      ) as HTMLButtonElement;
      expect(createButton).not.toBeNull();
      act(() => createButton.click());
      await flushReactWork();

      expect(createSession).toHaveBeenCalledWith("Westlake Project");
      expect(bridgeSendMock).toHaveBeenCalledTimes(1);
      const send = bridgeSendMock.mock.calls[0][0] as {
        sessionId: string;
        historyTopic?: string;
        text: string;
        onSessionActive?: (message: string) => void;
        onComplete?: () => void;
      };
      expect(send.sessionId).toBe(SESSION_ID);
      expect(send.historyTopic).toBe("slides westlake-project");
      expect(send.text).toBe("/new slides westlake-project");

      send.onSessionActive?.(send.text);
      expect(markSessionActive).toHaveBeenCalledWith(send.text);
      send.onComplete?.();
      expect(refreshSessions).toHaveBeenCalled();

      const stored = JSON.parse(
        localStorage.getItem(SESSION_TEMPLATE_STORAGE_KEY) || "{}",
      ) as Record<string, SessionTemplateRecord>;
      expect(stored[SESSION_ID]).toEqual({
        kind: "slides",
        title: "Westlake Project",
        topic: "slides westlake-project",
      });
    } finally {
      harness.unmount();
    }
  });

  it("renders template-specific sidebar labels for stored template sessions", () => {
    persistSessionTemplates({
      [SESSION_ID]: {
        kind: "podcast",
        title: "Async Audio",
      },
    });
    const harness = mount(
      makeSessionCtx({
        sessions: [{ id: SESSION_ID, message_count: 2, title: "Async Audio" }],
        currentSessionId: SESSION_ID,
      }),
    );
    try {
      const row = harness.container.querySelector(`[data-session-id="${SESSION_ID}"]`);
      expect(row).not.toBeNull();
      expect(row!.getAttribute("data-session-template")).toBe("podcast");
      expect(row!.textContent).toContain("Async Audio");
      expect(row!.textContent).toContain("Podcast Studio");
    } finally {
      harness.unmount();
    }
  });
});
