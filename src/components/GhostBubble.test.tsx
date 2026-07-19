import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProjectionEnvelopeV2 } from "@/runtime/projection-envelope-v2";
import * as ProjectionStore from "@/store/projection-store";
import * as ThreadStore from "@/store/thread-store";
import { GhostBubble, GHOST_SETTLE_TIMEOUT_MS } from "./GhostBubble";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const sessionId = "session-ghost";

function canonicalUser(cmid: string): ProjectionEnvelopeV2 {
  return {
    session_id: sessionId,
    thread_id: "thread-" + cmid,
    turn_id: "turn-" + cmid,
    seq: 1,
    client_message_id: cmid,
    cursor: { stream: "ledger-ghost", seq: 1 },
    payload: {
      type: "user_message",
      data: { text: "canonical user", files: [] },
    },
  };
}

function mount(node: React.ReactElement): {
  container: HTMLDivElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  ProjectionStore.__resetProjectionForTests();
  ThreadStore.__resetForTests();
});

describe("GhostBubble", () => {
  it("renders the optimistic user row without creating a legacy thread", () => {
    const harness = mount(
      <GhostBubble
        clientMessageId="cmid-visible"
        text="hello world"
        files={[]}
        sessionId={sessionId}
        onSettle={() => {}}
      />,
    );

    expect(
      harness.container.querySelector('[data-testid="ghost-bubble-text"]')
        ?.textContent,
    ).toBe("hello world");
    expect(
      harness.container
        .querySelector('[data-testid="ghost-bubble"]')
        ?.getAttribute("data-ghost-state"),
    ).toBe("pending");
    expect(ThreadStore.getThreads(sessionId)).toEqual([]);
    harness.unmount();
  });

  it("settles only when the canonical user_message has the exact client message id", () => {
    const onSettle = vi.fn();
    const harness = mount(
      <GhostBubble
        clientMessageId="cmid-target"
        text="send"
        files={[]}
        sessionId={sessionId}
        onSettle={onSettle}
      />,
    );
    const key = ProjectionStore.projectionStoreKey(sessionId);

    act(() => {
      ProjectionStore.ingest(key, canonicalUser("cmid-other"));
    });
    expect(onSettle).not.toHaveBeenCalled();

    act(() => {
      ProjectionStore.ingest(key, canonicalUser("cmid-target"));
    });
    expect(onSettle).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it("settles immediately when canonical reflection arrived before mount", () => {
    const key = ProjectionStore.projectionStoreKey(sessionId);
    ProjectionStore.ingest(key, canonicalUser("cmid-fast"));
    const onSettle = vi.fn();
    const harness = mount(
      <GhostBubble
        clientMessageId="cmid-fast"
        text="fast"
        files={[]}
        sessionId={sessionId}
        onSettle={onSettle}
      />,
    );
    expect(onSettle).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it("keeps an explicit RPC failure visible with retry instead of dropping the ghost", () => {
    const onRetry = vi.fn();
    const harness = mount(
      <GhostBubble
        clientMessageId="cmid-reject"
        text="retry me"
        files={[]}
        sessionId={sessionId}
        failure="turn/start rejected"
        onSettle={() => {}}
        onRetry={onRetry}
      />,
    );
    expect(
      harness.container.querySelector('[data-testid="ghost-bubble-error"]')
        ?.textContent,
    ).toContain("turn/start rejected");
    expect(
      harness.container
        .querySelector('[data-testid="ghost-bubble"]')
        ?.getAttribute("data-ghost-state"),
    ).toBe("failed");
    act(() => {
      (
        harness.container.querySelector(
          '[data-testid="ghost-bubble-retry"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it("keeps a compact retry state after canonical user settlement and terminal failure", () => {
    const onSettle = vi.fn();
    const harness = mount(
      <GhostBubble
        clientMessageId="cmid-terminal-failure"
        text="already canonical"
        files={[]}
        sessionId={sessionId}
        settled
        failure="provider stopped"
        onSettle={onSettle}
      />,
    );
    expect(onSettle).not.toHaveBeenCalled();
    expect(
      harness.container.querySelector(
        '[data-testid="ghost-bubble-terminal-error"]',
      )?.textContent,
    ).toContain("provider stopped");
    expect(
      harness.container.querySelector('[data-testid="ghost-bubble-text"]'),
    ).toBeNull();
    harness.unmount();
  });

  it("shows a retry state after the confirmation deadline", () => {
    const onRetry = vi.fn();
    const harness = mount(
      <GhostBubble
        clientMessageId="cmid-timeout"
        text="wait"
        files={[]}
        sessionId={sessionId}
        onSettle={() => {}}
        onRetry={onRetry}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(GHOST_SETTLE_TIMEOUT_MS + 1);
    });
    expect(
      harness.container.querySelector('[data-testid="ghost-bubble-error"]')
        ?.textContent,
    ).toContain("Send not confirmed");
    harness.unmount();
  });
});
