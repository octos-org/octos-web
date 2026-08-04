import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

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

vi.mock("@/store/file-store", () => ({
  loadSessionFiles: vi.fn(async () => {}),
  useFileStore: () => [],
  useAllFiles: () => [],
}));

vi.mock("@/store/task-store", () => ({
  useTasks: () => [],
}));

vi.mock("@/store/autonomy-store", () => ({
  useAutonomyState: () => ({ loops: [], goal: null }),
}));

vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: vi.fn(),
}));

vi.mock("@/studio/studio-sources-pane", () => ({
  StudioSourcesPane: () => null,
}));

vi.mock("@/studio/studio-rail", () => ({
  StudioRail: () => null,
}));

import { WorkspaceLayout } from "./workspace-layout";
import {
  SessionContext,
  type SessionContextValue,
} from "@/runtime/session-context";

const SESSION_ID = "web-1777700000000-title";

function makeSessionCtx(
  overrides: Partial<SessionContextValue> = {},
): SessionContextValue {
  return {
    sessions: [{ id: SESSION_ID, message_count: 2, title: "Original title" }],
    currentSessionId: SESSION_ID,
    historyTopic: undefined,
    currentSessionTitle: "Original title",
    currentSessionStats: null,
    activeTaskOnServer: false,
    queueMode: null,
    adaptiveMode: null,
    setServerTaskActive: () => {},
    renameSession: () => {},
    updateSessionStats: () => {},
    switchSession: () => {},
    goBack: async () => false,
    createSession: () => "web-new-session",
    removeSession: async () => {},
    refreshSessions: async () => {},
    markSessionActive: () => {},
    ...overrides,
  };
}

interface Mounted {
  container: HTMLDivElement;
  root: Root;
}

const mounted: Mounted[] = [];

async function mount(ctx: SessionContextValue = makeSessionCtx()): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // Async act flushes the loadSessionFiles() promise so the loading-state
  // update stays inside act.
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/chat"]}>
        <SessionContext.Provider value={ctx}>
          <WorkspaceLayout>
            <div data-testid="workspace-children" />
          </WorkspaceLayout>
        </SessionContext.Provider>
      </MemoryRouter>,
    );
  });
  const entry = { container, root };
  mounted.push(entry);
  return entry;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("WorkspaceLayout", () => {
  it("renders the topbar, sources pane, and center children", async () => {
    // jsdom defaults to innerWidth 1024: sources starts open (>= 1024),
    // rail starts closed (< 1280).
    const { container } = await mount();
    expect(container.querySelector("[data-testid='workspace-layout']")).not.toBeNull();
    expect(container.querySelector("[data-testid='workspace-sources-pane']")).not.toBeNull();
    expect(container.querySelector("[data-testid='workspace-children']")).not.toBeNull();
    expect(container.querySelector("[data-testid='workspace-rail']")).toBeNull();
  });

  it("hides the sources pane via the topbar toggle and persists it", async () => {
    const { container } = await mount();
    click(container.querySelector("[data-testid='workspace-toggle-sources']")!);
    expect(container.querySelector("[data-testid='workspace-sources-pane']")).toBeNull();
    expect(localStorage.getItem("octos-workspace-panes")).toContain('"sources":false');
  });

  it("opens the rail and switches between Artifacts and Runs tabs", async () => {
    const { container } = await mount();
    click(container.querySelector("[data-testid='workspace-toggle-rail']")!);
    const rail = container.querySelector("[data-testid='workspace-rail']");
    expect(rail).not.toBeNull();

    const artifactsTab = rail!.querySelector("[data-testid='workspace-tab-artifacts']")!;
    const runsTab = rail!.querySelector("[data-testid='workspace-tab-runs']")!;
    expect(artifactsTab.getAttribute("aria-selected")).toBe("true");

    click(runsTab);
    expect(runsTab.getAttribute("aria-selected")).toBe("true");
    expect(rail!.textContent).toContain("No runs yet");
  });

  it("injects a beforeSend that merges selected sources into turn media", async () => {
    // The nested provider must preserve the live session value and add
    // beforeSend. Capture it via a consumer rendered as the child.
    let seen: SessionContextValue | null = null;
    function Probe() {
      const value = React.useContext(SessionContext);
      React.useEffect(() => {
        seen = value;
      }, [value]);
      return null;
    }
    const container2 = document.createElement("div");
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    const ctx = makeSessionCtx();
    await act(async () => {
      root2.render(
        <MemoryRouter initialEntries={["/chat"]}>
          <SessionContext.Provider value={ctx}>
            <WorkspaceLayout>
              <Probe />
            </WorkspaceLayout>
          </SessionContext.Provider>
        </MemoryRouter>,
      );
    });
    mounted.push({ container: container2, root: root2 });

    expect(seen).not.toBeNull();
    const value = seen as unknown as SessionContextValue;
    expect(value.currentSessionId).toBe(SESSION_ID);
    expect(typeof value.beforeSend).toBe("function");
    const result = await value.beforeSend!({
      media: ["/a.png"],
    } as never);
    expect(result).toEqual({ media: ["/a.png"] });
  });
});
