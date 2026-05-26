import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("@/auth/auth-context", () => ({
  useAuth: () => ({
    user: { email: "ada@example.test" },
    portal: { can_access_admin_portal: false },
    logout: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-octos-status", () => ({
  useOctosStatus: () => ({ provider: "none", model: "none" }),
}));

vi.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({ theme: "dark", toggleTheme: vi.fn() }),
}));

vi.mock("@/hooks/use-resizable-panel", () => ({
  useResizablePanel: () => ({
    effectiveWidth: 320,
    isMaximized: false,
    onMouseDown: vi.fn(),
    toggleMaximize: vi.fn(),
  }),
}));

vi.mock("@/components/content-viewer", () => ({
  useContentViewer: () => ({
    state: { kind: null },
    openViewer: vi.fn(),
    closeViewer: vi.fn(),
    closeAudio: vi.fn(),
  }),
  ContentViewerOverlay: () => null,
}));

vi.mock("@/store/file-store", () => ({
  useFileStore: () => [],
}));

import { ChatLayout } from "./chat-layout";
import { SessionContext, type SessionContextValue } from "@/runtime/session-context";

const SESSION_ID = "web-1777700000000-title";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function makeSessionCtx(
  renameSession: SessionContextValue["renameSession"],
  title = "Original title",
): SessionContextValue {
  return {
    sessions: [{ id: SESSION_ID, message_count: 2, title }],
    currentSessionId: SESSION_ID,
    historyTopic: undefined,
    currentSessionTitle: title,
    currentSessionStats: null,
    initialMessages: [],
    activeTaskOnServer: false,
    queueMode: null,
    adaptiveMode: null,
    setServerTaskActive: () => {},
    renameSession,
    updateSessionStats: () => {},
    switchSession: () => {},
    goBack: async () => false,
    createSession: () => SESSION_ID,
    removeSession: async () => {},
    refreshSessions: async () => {},
    markSessionActive: () => {},
  };
}

function chatLayoutTree(
  renameSession: SessionContextValue["renameSession"],
  title = "Original title",
) {
  return (
    <SessionContext.Provider value={makeSessionCtx(renameSession, title)}>
      <ChatLayout>
        <div data-testid="chat-body">thread</div>
      </ChatLayout>
    </SessionContext.Provider>
  );
}

function mount(
  renameSession: SessionContextValue["renameSession"],
  title = "Original title",
): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(chatLayoutTree(renameSession, title));
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

function renameFromEditor(
  container: HTMLElement,
  testId: string,
  nextTitle: string,
) {
  const button = container.querySelector(
    `[data-testid='${testId}']`,
  ) as HTMLButtonElement;
  expect(button).not.toBeNull();
  act(() => button.click());

  const input = container.querySelector(
    `[data-testid='${testId}-input']`,
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  act(() => {
    input.value = nextTitle;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
});

describe("ChatLayout session title editing", () => {
  it("wires the main header and files panel titles to renameSession", () => {
    const renameSession = vi.fn();
    const harness = mount(renameSession);
    try {
      renameFromEditor(
        harness.container,
        "chat-session-title",
        "Renamed from header",
      );
      expect(renameSession).toHaveBeenCalledWith(
        SESSION_ID,
        "Renamed from header",
      );

      const filesButton = harness.container.querySelector(
        "button[title='Open files panel']",
      ) as HTMLButtonElement;
      expect(filesButton).not.toBeNull();
      act(() => filesButton.click());

      renameFromEditor(
        harness.container,
        "content-session-title",
        "Renamed from files",
      );
      expect(renameSession).toHaveBeenCalledWith(
        SESSION_ID,
        "Renamed from files",
      );
    } finally {
      harness.unmount();
    }
  });

  it("renders server title updates across header, history, and files surfaces", () => {
    const renameSession = vi.fn();
    const harness = mount(renameSession, "Original title");
    try {
      const filesButton = harness.container.querySelector(
        "button[title='Open files panel']",
      ) as HTMLButtonElement;
      act(() => filesButton.click());

      expect(
        harness.container.querySelector("[data-testid='chat-session-title']")
          ?.textContent,
      ).toContain("Original title");
      expect(
        harness.container.querySelector("[data-testid='content-session-title']")
          ?.textContent,
      ).toContain("Original title");
      expect(
        harness.container.querySelector(
          `[data-testid='session-item-${SESSION_ID}']`,
        )?.textContent,
      ).toContain("Original title");

      act(() => {
        harness.root.render(chatLayoutTree(renameSession, "Server title"));
      });

      expect(
        harness.container.querySelector("[data-testid='chat-session-title']")
          ?.textContent,
      ).toContain("Server title");
      expect(
        harness.container.querySelector("[data-testid='content-session-title']")
          ?.textContent,
      ).toContain("Server title");
      expect(
        harness.container.querySelector(
          `[data-testid='session-item-${SESSION_ID}']`,
        )?.textContent,
      ).toContain("Server title");
    } finally {
      harness.unmount();
    }
  });
});
