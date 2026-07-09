/**
 * Rewind-to-here affordance on user bubbles (session/rollback UI).
 *
 * Covers: two-click confirm (single click must never rewind), correct
 * `num_turns` for older bubbles (threads.length - index), composer
 * prefill dispatch on success, and inline error on the server's
 * turn-in-progress guard.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const rollbackSessionTurns = vi.fn();
vi.mock("@/runtime/session-rollback", () => ({
  rollbackSessionTurns: (...args: unknown[]) => rollbackSessionTurns(...args),
  // The bubble also reads the scope-busy flag; never busy in these tests.
  useRollbackBusy: () => false,
}));

import { ChatThread } from "./chat-thread";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";
import * as ThreadStore from "@/store/thread-store";

const SESSION = "sess-rewind-ui";

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

function mountThread(): MountedHarness {
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

function seedTwoTurns(): { firstThreadId: string; secondThreadId: string } {
  ThreadStore.addUserMessage(SESSION, {
    text: "first prompt",
    clientMessageId: "cmid-first",
  });
  ThreadStore.appendAssistantToken("cmid-first", "first reply");
  ThreadStore.finalizeAssistant("cmid-first", { committedSeq: 2 });
  ThreadStore.addUserMessage(SESSION, {
    text: "second prompt",
    clientMessageId: "cmid-second",
  });
  ThreadStore.appendAssistantToken("cmid-second", "second reply");
  ThreadStore.finalizeAssistant("cmid-second", { committedSeq: 4 });
  const threads = ThreadStore.getThreads(SESSION);
  expect(threads).toHaveLength(2);
  return { firstThreadId: threads[0].id, secondThreadId: threads[1].id };
}

function rewindButton(
  harness: MountedHarness,
  threadId: string,
): HTMLButtonElement {
  const el = harness.container.querySelector(
    `[data-testid="rewind-to-${threadId}"]`,
  ) as HTMLButtonElement | null;
  expect(el).toBeTruthy();
  return el as HTMLButtonElement;
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  ThreadStore.__resetForTests();
  rollbackSessionTurns.mockReset();
});

describe("user-bubble rewind affordance", () => {
  it("requires a second confirming click before calling session/rollback", async () => {
    rollbackSessionTurns.mockResolvedValue({ ok: true, droppedTurns: 1 });
    const { secondThreadId } = seedTwoTurns();
    const harness = mountThread();
    const btn = rewindButton(harness, secondThreadId);

    act(() => btn.click());
    // Armed, not fired.
    expect(rollbackSessionTurns).not.toHaveBeenCalled();
    expect(rewindButton(harness, secondThreadId).textContent).toContain(
      "Confirm",
    );

    await act(async () => {
      rewindButton(harness, secondThreadId).click();
    });
    // Newest turn → num_turns = 1.
    expect(rollbackSessionTurns).toHaveBeenCalledWith(SESSION, undefined, 1);
    harness.unmount();
  });

  it("computes num_turns from the bubble's distance from the end", async () => {
    rollbackSessionTurns.mockResolvedValue({ ok: true, droppedTurns: 2 });
    const { firstThreadId } = seedTwoTurns();
    const harness = mountThread();

    act(() => rewindButton(harness, firstThreadId).click());
    await act(async () => {
      rewindButton(harness, firstThreadId).click();
    });
    // Oldest of two turns → rewinding here drops BOTH.
    expect(rollbackSessionTurns).toHaveBeenCalledWith(SESSION, undefined, 2);
    harness.unmount();
  });

  it("prefills the composer with the dropped prompt on success", async () => {
    rollbackSessionTurns.mockResolvedValue({ ok: true, droppedTurns: 1 });
    const { secondThreadId } = seedTwoTurns();
    const harness = mountThread();
    const prefills: Array<{ sessionId?: string; text?: string }> = [];
    const onPrefill = (e: Event) =>
      prefills.push((e as CustomEvent).detail as { text?: string });
    window.addEventListener("crew:composer_prefill", onPrefill);

    act(() => rewindButton(harness, secondThreadId).click());
    await act(async () => {
      rewindButton(harness, secondThreadId).click();
    });
    window.removeEventListener("crew:composer_prefill", onPrefill);
    expect(prefills).toHaveLength(1);
    expect(prefills[0].text).toBe("second prompt");
    expect(prefills[0].sessionId).toBe(SESSION);
    harness.unmount();
  });

  it("excludes orphan placeholder threads from the affordance and the count", async () => {
    // codex #262 P1: a late-event orphan bucket (empty placeholder user
    // message) is NOT a persisted user turn — it must get no Rewind
    // button, and rewinding the real turn BEFORE it must not count it.
    rollbackSessionTurns.mockResolvedValue({ ok: true, droppedTurns: 1 });
    const { secondThreadId } = seedTwoTurns();
    // Mint an orphan bucket the way the store does for late events:
    // a tool progress line for an unknown thread id.
    ThreadStore.appendToolProgress("orphan-thread-1", "tc-orphan", "late");
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.length).toBe(3);
    const harness = mountThread();
    // The orphan bubble renders no rewind button.
    expect(
      harness.container.querySelector(
        '[data-testid="rewind-to-orphan-thread-1"]',
      ),
    ).toBeNull();
    // Rewinding the newest REAL turn still sends num_turns = 1 — the
    // trailing orphan does not inflate the count.
    const btn = harness.container.querySelector(
      `[data-testid="rewind-to-${secondThreadId}"]`,
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    act(() => btn.click());
    await act(async () => {
      (
        harness.container.querySelector(
          `[data-testid="rewind-to-${secondThreadId}"]`,
        ) as HTMLButtonElement
      ).click();
    });
    expect(rollbackSessionTurns).toHaveBeenCalledWith(SESSION, undefined, 1);
    harness.unmount();
  });

  it("surfaces the turn-in-progress guard inline and does not prefill", async () => {
    rollbackSessionTurns.mockResolvedValue({
      ok: false,
      reason: "turn_in_progress",
    });
    const { secondThreadId } = seedTwoTurns();
    const harness = mountThread();
    const prefills: Event[] = [];
    const onPrefill = (e: Event) => prefills.push(e);
    window.addEventListener("crew:composer_prefill", onPrefill);

    act(() => rewindButton(harness, secondThreadId).click());
    await act(async () => {
      rewindButton(harness, secondThreadId).click();
    });
    window.removeEventListener("crew:composer_prefill", onPrefill);
    const error = harness.container.querySelector(
      '[data-testid="rewind-error"]',
    );
    expect(error?.textContent).toContain("turn is running");
    expect(prefills).toHaveLength(0);
    harness.unmount();
  });
});
