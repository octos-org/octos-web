/**
 * M9-γ-4 GhostBubble unit tests.
 *
 * Issue: octos-org/octos#841.
 * Component: `src/components/GhostBubble.tsx`.
 *
 * Coverage:
 *   1. Mounts a visible bubble with the typed text.
 *   2. Calls `onSettle` once the projection captures `UserView` with
 *      the matching `client_message_id` (the spec's match-and-unmount
 *      contract).
 *   3. Does NOT call `onSettle` for an unrelated cmid landing in the
 *      projection (negative case — the predicate is exact-match).
 *   4. Surfaces an inline error + Retry button after the 30s timeout
 *      and wires Retry to the parent callback.
 *   5. (chat-thread integration) flag-OFF: clicking Send still
 *      `addUserMessage`s into ThreadStore — exactly today's behaviour.
 *      flag-ON: ThreadStore stays free of an optimistic row; the
 *      ghost lives outside the store.
 *
 * Test rig: minimal `react-dom/client` + `react.act` (no
 * `@testing-library/react` available in the workspace). Each test
 * mounts into a fresh detached `<div>` so DOM state never leaks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// React 18+ test rig flag: opts the runtime into the `act(...)` warning
// suppression path. Without this, every test render logs:
// "The current testing environment is not configured to support act(...)".
// Set ONCE at module load — vitest spawns one process per file.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import * as ThreadStore from "@/store/thread-store";
import {
  __resetProjectionForTests,
  __setProjectionV1ForTests,
  ingest as projectionIngest,
  isProjectionV1Enabled,
  projectionStoreKey,
} from "@/store/projection-store";
import type { Envelope } from "@/runtime/ui-protocol-types";

import { GhostBubble, GHOST_SETTLE_TIMEOUT_MS } from "./GhostBubble";

const SESSION = "sess-ghost";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
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
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Synthesize a user-rooted envelope that introduces a thread with the
 *  given cmid. Uses an `assistant_delta` payload so the projection's
 *  first-envelope-captures-cmid path fires (any payload type works —
 *  identity is on `(thread_id, seq)`, the cmid travels on the
 *  envelope itself). */
function userRootedEnvelope(
  threadId: string,
  seq: number,
  cmid: string,
): Envelope {
  return {
    thread_id: threadId,
    seq,
    client_message_id: cmid,
    payload: { type: "assistant_delta", data: { text: "hi" } },
  };
}

describe("GhostBubble", () => {
  beforeEach(() => {
    __setProjectionV1ForTests(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetProjectionForTests();
    ThreadStore.__resetForTests();
  });

  it("renders the typed text right-aligned with the user-bubble classes", () => {
    const { container, unmount } = mount(
      <GhostBubble
        clientMessageId="cmid-1"
        text="hello world"
        files={[]}
        sessionId={SESSION}
        onSettle={() => {}}
      />,
    );
    const bubble = container.querySelector('[data-testid="ghost-bubble"]');
    expect(bubble).not.toBeNull();
    const textEl = container.querySelector('[data-testid="ghost-bubble-text"]');
    expect(textEl?.textContent).toBe("hello world");
    // Visual parity with `ThreadUserBubble`: same `message-card-user`
    // glass classes guarantee identical render.
    expect(textEl?.className).toContain("message-card-user");
    expect(bubble?.getAttribute("data-ghost-state")).toBe("pending");
    unmount();
  });

  it("calls onSettle when projection captures matching client_message_id", () => {
    const onSettle = vi.fn();
    const { unmount } = mount(
      <GhostBubble
        clientMessageId="cmid-2"
        text="hi"
        files={[]}
        sessionId={SESSION}
        onSettle={onSettle}
      />,
    );
    expect(onSettle).not.toHaveBeenCalled();

    // Push an envelope that introduces a thread carrying the matching
    // cmid. We `ingest` directly into the projection-store and then
    // pulse `notify()` via the ThreadStore's public surface — the
    // GhostBubble subscribes to ThreadStore (γ-3 dual-write trigger).
    const key = projectionStoreKey(SESSION);
    projectionIngest(key, userRootedEnvelope("thr-2", 1, "cmid-2"));
    act(() => {
      // Any thread-store mutation that fires `notify()` will do — use a
      // public mutator. Adding a user message in a different session
      // forces a notify without polluting the test session's threads.
      ThreadStore.addUserMessage("__notify-pulse__", {
        text: "pulse",
        clientMessageId: "pulse-cmid",
      });
    });

    expect(onSettle).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not settle for an unrelated cmid in the projection", () => {
    const onSettle = vi.fn();
    const { unmount } = mount(
      <GhostBubble
        clientMessageId="cmid-target"
        text="hi"
        files={[]}
        sessionId={SESSION}
        onSettle={onSettle}
      />,
    );

    const key = projectionStoreKey(SESSION);
    projectionIngest(key, userRootedEnvelope("thr-x", 1, "different-cmid"));
    act(() => {
      ThreadStore.addUserMessage("__notify-pulse__", {
        text: "pulse",
        clientMessageId: "pulse-cmid",
      });
    });

    expect(onSettle).not.toHaveBeenCalled();
    unmount();
  });

  it("settles synchronously when the projection already carries the cmid at mount", () => {
    // Race case: the server's reflection landed inside the same
    // microtask as the send dispatch, so the cmid is already in the
    // projection by the time the effect runs. Settling synchronously
    // avoids a flash of the optimistic bubble after it's already
    // confirmed.
    const key = projectionStoreKey(SESSION);
    projectionIngest(key, userRootedEnvelope("thr-fast", 1, "cmid-fast"));

    const onSettle = vi.fn();
    const { unmount } = mount(
      <GhostBubble
        clientMessageId="cmid-fast"
        text="hi"
        files={[]}
        sessionId={SESSION}
        onSettle={onSettle}
      />,
    );

    expect(onSettle).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("surfaces an inline error + Retry after the 30s timeout", () => {
    const onSettle = vi.fn();
    const onRetry = vi.fn();
    const { container, unmount } = mount(
      <GhostBubble
        clientMessageId="cmid-timeout"
        text="will time out"
        files={[]}
        sessionId={SESSION}
        onSettle={onSettle}
        onRetry={onRetry}
      />,
    );

    expect(
      container.querySelector('[data-testid="ghost-bubble-error"]'),
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(GHOST_SETTLE_TIMEOUT_MS + 100);
    });

    const err = container.querySelector('[data-testid="ghost-bubble-error"]');
    expect(err).not.toBeNull();
    const retryBtn = container.querySelector(
      '[data-testid="ghost-bubble-retry"]',
    ) as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();

    act(() => {
      retryBtn!.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    // Retry resets the error state (timer rearms internally).
    expect(
      container.querySelector('[data-testid="ghost-bubble-error"]'),
    ).toBeNull();
    expect(onSettle).not.toHaveBeenCalled();
    unmount();
  });

  it("renders attached files as inline rows", () => {
    const fileA = new File(["aaa"], "a.txt", { type: "text/plain" });
    const fileB = new File(["bbb"], "b.png", { type: "image/png" });
    const { container, unmount } = mount(
      <GhostBubble
        clientMessageId="cmid-files"
        text="see attached"
        files={[fileA, fileB]}
        sessionId={SESSION}
        onSettle={() => {}}
      />,
    );
    const fileRows = container.querySelectorAll(
      '[data-testid="ghost-bubble-file"]',
    );
    expect(fileRows.length).toBe(2);
    expect(fileRows[0].textContent).toContain("a.txt");
    expect(fileRows[1].textContent).toContain("b.png");
    unmount();
  });
});

// ─── Integration with ThreadStore — flag invariant ─────────────────────────
//
// The acceptance criterion: "ThreadStore must NOT have a `<GhostBubble>`
// row when flag ON". We assert this by reproducing the Composer's
// flag-ON path (skip `addUserMessage`, register pending cmid) and
// confirming `getThreads` reports zero threads — exactly the contract
// γ-4 establishes for the optimistic surface.

describe("GhostBubble × ThreadStore [flag invariant]", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetProjectionForTests();
    ThreadStore.__resetForTests();
  });

  it("flag OFF: ThreadStore.addUserMessage produces a thread (today's behaviour)", () => {
    __setProjectionV1ForTests(false);
    expect(isProjectionV1Enabled()).toBe(false);

    ThreadStore.addUserMessage(SESSION, {
      text: "hello",
      clientMessageId: "cmid-legacy",
    });
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.length).toBe(1);
    expect(threads[0].userMsg.text).toBe("hello");
  });

  it("flag ON: GhostBubble path leaves ThreadStore free of an optimistic row", () => {
    __setProjectionV1ForTests(true);
    expect(isProjectionV1Enabled()).toBe(true);

    // Mirror the Composer's flag-ON branch: register the pending cmid
    // and mount a GhostBubble — but DO NOT call addUserMessage.
    ThreadStore.registerPendingClientMessageId(
      SESSION,
      "cmid-ghost",
      "cmid-ghost",
    );
    const onSettle = vi.fn();
    const harness = mount(
      <GhostBubble
        clientMessageId="cmid-ghost"
        text="ghost-only send"
        files={[]}
        sessionId={SESSION}
        onSettle={onSettle}
      />,
    );

    // No row in ThreadStore — exactly the spec's acceptance criterion.
    expect(ThreadStore.getThreads(SESSION).length).toBe(0);

    harness.unmount();
  });
});
