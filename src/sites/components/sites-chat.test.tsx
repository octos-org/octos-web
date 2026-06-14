import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { SiteProject } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const threadStoreMocks = vi.hoisted(() => ({
  loadHistory: vi.fn(),
}));
const bridgeSendMock = vi.hoisted(() => vi.fn());
const sitesApiMocks = vi.hoisted(() => ({
  hydrateSiteProjectFromSession: vi.fn(),
}));
const sitesContextMocks = vi.hoisted(() => ({
  project: undefined as SiteProject | undefined,
  save: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  ensureSelectedProfileId: vi.fn(async () => "alan0x"),
  getSelectedProfileId: vi.fn(() => "alan0x"),
}));

vi.mock("@/components/chat-thread", () => ({
  ChatThread: () => null,
}));

vi.mock("@/runtime/runtime-provider", () => ({
  ScopedRuntimeBridge: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/runtime/ui-protocol-send", () => ({
  sendMessage: bridgeSendMock,
}));

vi.mock("@/store/thread-store", () => ({
  useThreads: () => [],
  ...threadStoreMocks,
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    hydrateSiteProjectFromSession: sitesApiMocks.hydrateSiteProjectFromSession,
  };
});

vi.mock("../context/sites-context", () => ({
  useSites: () => ({
    project: sitesContextMocks.project,
    save: sitesContextMocks.save,
  }),
}));

vi.mock("./sites-task-status-indicator", () => ({
  SitesTaskStatusIndicator: () => null,
}));

import { SitesChat } from "./sites-chat";

const SESSION_ID = "site-1780848551864-yy2u0k";
const TOPIC = "site learning";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function installLocalStorageStub(): void {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  } satisfies Storage;
  vi.stubGlobal("localStorage", storage);
}

function seedProject(update: Partial<SiteProject> = {}) {
  const now = 1_780_848_551_864;
  sitesContextMocks.project = {
    id: SESSION_ID,
    title: "Physics Learning Studio",
    createdAt: now,
    updatedAt: now,
    preset: "learning",
    template: "quarto-lesson",
    siteKind: "docs",
    slug: "physics-learning-studio",
    scaffolded: true,
    profileId: "alan0x",
    ...update,
  };
}

async function mountSitesChat(): Promise<MountedHarness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SitesChat sessionId={SESSION_ID} />);
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
  installLocalStorageStub();
  localStorage.clear();
  threadStoreMocks.loadHistory.mockReset();
  bridgeSendMock.mockReset();
  sitesApiMocks.hydrateSiteProjectFromSession.mockReset();
  sitesContextMocks.project = undefined;
  sitesContextMocks.save.mockReset();
  sitesApiMocks.hydrateSiteProjectFromSession.mockResolvedValue({
    id: SESSION_ID,
    title: "Physics Learning Studio",
    createdAt: 1,
    updatedAt: 1,
    preset: "learning",
    template: "quarto-lesson",
    siteKind: "docs",
    slug: "physics-learning-studio",
    scaffolded: true,
    profileId: "alan0x",
  });
});

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  localStorage.clear();
});

describe("SitesChat approval requests", () => {
  it("does not auto-scaffold or hydrate an already scaffolded local project", async () => {
    seedProject({ scaffolded: true, slug: "physics-learning-studio" });
    sitesApiMocks.hydrateSiteProjectFromSession.mockRejectedValue(
      new Error("HTTP 503"),
    );

    const harness = await mountSitesChat();
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(sitesApiMocks.hydrateSiteProjectFromSession).not.toHaveBeenCalled();
      expect(bridgeSendMock).not.toHaveBeenCalled();
      expect(sitesContextMocks.save).not.toHaveBeenCalledWith(
        expect.objectContaining({
          scaffolded: false,
          scaffoldError: "HTTP 503",
        }),
      );
    } finally {
      harness.unmount();
    }
  });

  it("renders a blocking approval dialog for a topic-scoped approval", async () => {
    seedProject();
    const harness = await mountSitesChat();
    try {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("crew:approval_requested", {
            detail: {
              session_id: `${SESSION_ID}#${TOPIC}`,
              topic: TOPIC,
              approval_id: "approval-shell-30",
              turn_id: "turn-1",
              tool_name: "shell",
              title: "Approve shell command",
              body: "Run command: quarto render",
            },
          }),
        );
      });

      const dialog = harness.container.querySelector("[role='dialog']");
      expect(dialog?.textContent).toContain("Approve shell command");
      expect(dialog?.textContent).toContain("quarto render");
    } finally {
      harness.unmount();
    }
  });
});
