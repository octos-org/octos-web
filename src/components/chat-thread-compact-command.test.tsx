/**
 * Composer `/compact` command (CLI parity; server `session/compact`,
 * octos#1671).
 *
 * The command issues the RPC with the SCOPED session id — the server
 * takes the key verbatim and there is no topic param, so a topic bucket
 * compacts only when addressed as `session#topic`. Success feedback is
 * NOT local: the server emits the usual compaction lifecycle events and
 * `CompactionIndicator` renders them; the composer pill only surfaces
 * RPC-level failures (old server, no runtime).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/api/sessions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/api/sessions")>();
  return {
    ...original,
    compactSession: vi.fn(),
  };
});

import { compactSession } from "@/api/sessions";
import { ChatThread } from "./chat-thread";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";
import * as ThreadStore from "@/store/thread-store";

const SESSION = "sess-compact-command";
const compactMock = vi.mocked(compactSession);

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function makeSessionCtx(topic?: string): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: SESSION,
    historyTopic: topic,
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

function mountThread(topic?: string): MountedHarness {
  return mount(
    <SessionContext.Provider value={makeSessionCtx(topic)}>
      <ChatThread />
    </SessionContext.Provider>,
  );
}

function getInput(harness: MountedHarness): HTMLTextAreaElement {
  const el = harness.container.querySelector(
    '[data-testid="chat-input"]',
  ) as HTMLTextAreaElement | null;
  expect(el).toBeTruthy();
  return el as HTMLTextAreaElement;
}

function getSendButton(harness: MountedHarness): HTMLButtonElement {
  const el = harness.container.querySelector(
    '[data-testid="send-button"]',
  ) as HTMLButtonElement | null;
  expect(el).toBeTruthy();
  return el as HTMLButtonElement;
}

/** Controlled-component value injection: React's value tracker ignores a
 *  plain `el.value =`, so go through the native setter before input. */
function typeText(harness: MountedHarness, value: string) {
  const textarea = getInput(harness);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  expect(setter).toBeTruthy();
  act(() => {
    setter!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSend(harness: MountedHarness) {
  await act(async () => {
    getSendButton(harness).click();
  });
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
  compactMock.mockReset();
});

describe("composer /compact command", () => {
  it("issues session/compact with the bare session id outside topics", async () => {
    compactMock.mockResolvedValue({
      session_id: SESSION,
      compacted: true,
      token_estimate_before: 87400,
      token_estimate_after: 31200,
    });
    const harness = mountThread();
    typeText(harness, "/compact");
    await clickSend(harness);
    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(compactMock).toHaveBeenCalledWith(SESSION);
    // The composer clears for the next message; success feedback is the
    // server-emitted lifecycle notice, not a local pill.
    expect(getInput(harness).value).toBe("");
    expect(
      harness.container.querySelector('[data-testid="cmd-feedback"]'),
    ).toBeNull();
    harness.unmount();
  });

  it("addresses a topic bucket with its scoped session#topic id", async () => {
    compactMock.mockResolvedValue({
      session_id: `${SESSION}#slides`,
      compacted: true,
      token_estimate_before: 1200,
      token_estimate_after: 300,
    });
    const harness = mountThread("slides");
    typeText(harness, "/compact");
    await clickSend(harness);
    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(compactMock).toHaveBeenCalledWith(`${SESSION}#slides`);
    harness.unmount();
  });

  it("surfaces an RPC failure in the feedback pill", async () => {
    compactMock.mockRejectedValue(new Error("method not found"));
    const harness = mountThread();
    typeText(harness, "/compact");
    await clickSend(harness);
    expect(compactMock).toHaveBeenCalledTimes(1);
    const pill = harness.container.querySelector(
      '[data-testid="cmd-feedback"]',
    );
    expect(pill).toBeTruthy();
    expect(pill!.textContent).toContain("Compact failed: method not found");
    harness.unmount();
  });
});
