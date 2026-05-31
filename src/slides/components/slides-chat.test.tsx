import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { SlidesProject } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const bridgeSendMock = vi.hoisted(() => vi.fn());
const threadStoreMocks = vi.hoisted(() => ({
  loadHistory: vi.fn(),
}));
const slidesApiMocks = vi.hoisted(() => ({
  buildSlidesSlug: vi.fn(),
  fetchSlidesManifest: vi.fn(),
  listSlidesFiles: vi.fn(),
  waitForSlidesScaffold: vi.fn(),
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

vi.mock("@/store/thread-store", () => threadStoreMocks);

vi.mock("../api", () => slidesApiMocks);

vi.mock("./slides-task-status-indicator", () => ({
  SlidesTaskStatusIndicator: () => null,
}));

import { SlidesProvider } from "../context/slides-context";
import { getSlidesProject, upsertSlidesProject } from "../store";
import { SlidesChat } from "./slides-chat";

const SESSION_ID = "slides-1777700000000-race1";
const GENERATED_SLUG = "malformed-prompt-deck-race1";
const SERVER_ERROR = "server rejected malformed slides prompt";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function seedProject(update: Partial<SlidesProject> = {}) {
  const now = 1_777_700_000_000;
  upsertSlidesProject({
    id: SESSION_ID,
    title: "Malformed Prompt Deck",
    createdAt: now,
    updatedAt: now,
    slides: [],
    template: "business",
    tags: [],
    versions: [],
    scaffolded: false,
    ...update,
  });
}

async function mountSlidesChat(): Promise<MountedHarness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SlidesProvider projectId={SESSION_ID}>
        <SlidesChat sessionId={SESSION_ID} />
      </SlidesProvider>,
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

async function flushAsyncWork() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  bridgeSendMock.mockReset();
  threadStoreMocks.loadHistory.mockReset();
  slidesApiMocks.buildSlidesSlug.mockReset();
  slidesApiMocks.fetchSlidesManifest.mockReset();
  slidesApiMocks.listSlidesFiles.mockReset();
  slidesApiMocks.waitForSlidesScaffold.mockReset();
  slidesApiMocks.buildSlidesSlug.mockReturnValue(GENERATED_SLUG);
  slidesApiMocks.waitForSlidesScaffold.mockRejectedValue(
    new Error(`slides scaffold did not appear for ${GENERATED_SLUG}`),
  );
});

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  localStorage.clear();
});

describe("SlidesChat auto-scaffold error handling", () => {
  it("keeps the first scaffold error listener alive after pre-saving a new slug", async () => {
    seedProject();
    const harness = await mountSlidesChat();
    try {
      expect(bridgeSendMock).toHaveBeenCalledTimes(1);
      const request = bridgeSendMock.mock.calls[0][0] as {
        historyTopic: string;
        onComplete: () => void;
        text: string;
      };
      expect(request.historyTopic).toBe(`slides ${GENERATED_SLUG}`);
      expect(request.text).toBe(`/new slides ${GENERATED_SLUG}`);
      expect(getSlidesProject(SESSION_ID)?.slug).toBe(GENERATED_SLUG);

      act(() => {
        window.dispatchEvent(
          new CustomEvent("crew:turn_error", {
            detail: {
              sessionId: SESSION_ID,
              topic: `slides ${GENERATED_SLUG}`,
              error: { message: SERVER_ERROR },
            },
          }),
        );
      });

      request.onComplete();
      await flushAsyncWork();

      expect(slidesApiMocks.waitForSlidesScaffold).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        slug: GENERATED_SLUG,
      });
      const saved = getSlidesProject(SESSION_ID);
      expect(saved?.scaffolded).toBe(false);
      expect(saved?.scaffoldError).toBe(SERVER_ERROR);
      expect(saved?.scaffoldError).not.toContain("did not appear");
    } finally {
      harness.unmount();
    }
  });
});
