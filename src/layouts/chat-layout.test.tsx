import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const resizableMocks = vi.hoisted(() => {
  const filesMouseDown = vi.fn();
  const historyMouseDown = vi.fn();
  const toggleMaximize = vi.fn();
  const useResizablePanel = vi.fn((options?: { storageKey?: string }) => {
    const isHistory = options?.storageKey === "octos_history_panel_width";
    return {
      effectiveWidth: isHistory ? 288 : 320,
      isMaximized: false,
      onMouseDown: isHistory ? historyMouseDown : filesMouseDown,
      toggleMaximize,
    };
  });
  return {
    filesMouseDown,
    historyMouseDown,
    toggleMaximize,
    useResizablePanel,
  };
});

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
  useResizablePanel: resizableMocks.useResizablePanel,
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
  sessionId = SESSION_ID,
): SessionContextValue {
  return {
    sessions: [{ id: sessionId, message_count: 2, title }],
    currentSessionId: sessionId,
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
  sessionId = SESSION_ID,
) {
  return (
    <SessionContext.Provider value={makeSessionCtx(renameSession, title, sessionId)}>
      <ChatLayout>
        <div data-testid="chat-body">thread</div>
      </ChatLayout>
    </SessionContext.Provider>
  );
}

function mount(
  renameSession: SessionContextValue["renameSession"],
  title = "Original title",
  sessionId = SESSION_ID,
): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(chatLayoutTree(renameSession, title, sessionId));
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
  resizableMocks.filesMouseDown.mockClear();
  resizableMocks.historyMouseDown.mockClear();
  resizableMocks.toggleMaximize.mockClear();
  resizableMocks.useResizablePanel.mockClear();
});

describe("ChatLayout panel layout", () => {
  it("renders the shared glass shell with left/right resize handles", () => {
    const renameSession = vi.fn();
    const harness = mount(renameSession);
    try {
      const sidebar = harness.container.querySelector(
        "aside.sidebar-scope",
      ) as HTMLElement;
      const main = harness.container.querySelector("main") as HTMLElement;
      expect(sidebar).not.toBeNull();
      expect(main).not.toBeNull();
      expect(sidebar.className).toContain("glass-panel");
      expect(main.className).toContain("glass-panel");
      expect(sidebar.style.width).toBe("288px");

      const historyTitle = [...harness.container.querySelectorAll("div")].find(
        (node) => node.textContent === "Chat History",
      );
      expect(historyTitle).toBeTruthy();
      expect(historyTitle?.className).not.toContain("text-center");
      expect(historyTitle?.closest(".items-start")).not.toBeNull();

      const initialHandles =
        harness.container.querySelectorAll(".panel-resize-handle");
      expect(initialHandles).toHaveLength(1);
      expect(initialHandles[0].getAttribute("title")).toBe(
        "Resize chat history",
      );

      const filesButton = harness.container.querySelector(
        "button[title='Open files panel']",
      ) as HTMLButtonElement;
      act(() => filesButton.click());

      const handles = harness.container.querySelectorAll(".panel-resize-handle");
      expect(handles).toHaveLength(2);
      expect(
        harness.container.querySelector("[data-testid='content-session-title']")
          ?.closest(".glass-panel"),
      ).not.toBeNull();
      const contentPanelWrapper = harness.container
        .querySelector("[data-testid='content-session-title']")
        ?.closest("[style]");
      expect((contentPanelWrapper as HTMLElement | null)?.style.width).toBe(
        "320px",
      );
      expect(resizableMocks.useResizablePanel).toHaveBeenCalledWith({
        minWidth: 240,
        maxWidth: 520,
        defaultWidth: 288,
        storageKey: "octos_history_panel_width",
        side: "left",
      });
    } finally {
      harness.unmount();
    }
  });

  it("keeps the panel shell stable across session context refreshes", () => {
    const renameSession = vi.fn();
    const harness = mount(renameSession, "Original title", SESSION_ID);
    try {
      const filesButton = harness.container.querySelector(
        "button[title='Open files panel']",
      ) as HTMLButtonElement;
      act(() => filesButton.click());
      expect(
        harness.container.querySelectorAll(".panel-resize-handle"),
      ).toHaveLength(2);

      const nextSessionId = "web-1777700000001-layout";
      act(() => {
        harness.root.render(
          chatLayoutTree(renameSession, "Switched session", nextSessionId),
        );
      });

      expect(
        harness.container.querySelectorAll(".panel-resize-handle"),
      ).toHaveLength(2);
      expect(
        (
          harness.container.querySelector("aside.sidebar-scope") as HTMLElement
        ).style.width,
      ).toBe("288px");
      expect(
        harness.container.querySelector("[data-testid='content-session-title']")
          ?.textContent,
      ).toContain("Switched session");
      expect(
        harness.container.querySelector(
          `[data-testid='session-item-${nextSessionId}']`,
        )?.textContent,
      ).toContain("Switched session");
    } finally {
      harness.unmount();
    }
  });
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
