/**
 * CompactionIndicator (UPCR-2026-026) — the SPA sibling of octos-tui#253.
 *
 * Covers:
 *  1. `crew:compaction phase:"started"` renders the in-progress block with
 *     the honest threshold-relative bar + percent.
 *  2. `phase:"completed"` swaps it for the `before → after` notice and
 *     auto-clears after the timeout.
 *  3. Cross-session events are dropped by the scope filter.
 *  4. Hang safety: a `crew:thinking thinking:false` falling edge clears a
 *     dangling started-block (lost completed event) but leaves a
 *     completed notice to its own timer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { CompactionIndicator } from "./compaction-indicator";
import { progressBar } from "@/lib/progress-bar";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";

const SESSION = "sess-compaction";

function makeSessionCtx(): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: SESSION,
    historyTopic: undefined,
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <SessionContext.Provider value={makeSessionCtx()}>
        <CompactionIndicator />
      </SessionContext.Provider>,
    );
  });
}

function fire(name: string, detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Guarded: the pure-utility test never mounts (codex P3 — a solo
  // `vitest -t progressBar` run would crash cleanup otherwise).
  if (root) {
    const mounted = root;
    act(() => {
      mounted.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe("CompactionIndicator", () => {
  it("renders the honest bar on started and the notice on completed", () => {
    mount();
    expect(container!.querySelector("[data-testid='compaction-indicator']")).toBeNull();

    fire("crew:compaction", {
      session_id: SESSION,
      phase: "started",
      token_estimate: 48000,
      threshold_tokens: 96000,
      trigger: "preflight",
    });
    const block = container!.querySelector("[data-testid='compaction-indicator']");
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("Compacting conversation");
    expect(block!.textContent).toContain("48.0k tokens");
    const bar = container!.querySelector("[data-testid='compaction-bar']");
    expect(bar!.textContent).toContain("50% of compact threshold");
    // 50% of a 40-cell bar = 20 filled.
    expect(bar!.textContent).toContain("▰".repeat(20) + "▱".repeat(20));

    fire("crew:compaction", {
      session_id: SESSION,
      phase: "completed",
      token_estimate_before: 48000,
      token_estimate_after: 12000,
      retained_count: 8,
      dropped_count: 42,
      error: null,
    });
    const notice = container!.querySelector("[data-testid='compaction-indicator']");
    expect(notice!.textContent).toContain("context compacted 48.0k → 12.0k tokens");

    // Auto-clears after the timeout.
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(container!.querySelector("[data-testid='compaction-indicator']")).toBeNull();
  });

  it("drops cross-session events", () => {
    mount();
    fire("crew:compaction", {
      session_id: "other-session",
      phase: "started",
      token_estimate: 1000,
      threshold_tokens: 2000,
      trigger: "preflight",
    });
    expect(container!.querySelector("[data-testid='compaction-indicator']")).toBeNull();
  });

  it("clears a dangling started-block on the thinking falling edge", () => {
    mount();
    fire("crew:compaction", {
      session_id: SESSION,
      phase: "started",
      token_estimate: 1000,
      threshold_tokens: 2000,
      trigger: "preflight",
    });
    expect(container!.querySelector("[data-testid='compaction-indicator']")).not.toBeNull();

    fire("crew:thinking", { session_id: SESSION, thinking: false });
    expect(container!.querySelector("[data-testid='compaction-indicator']")).toBeNull();
  });

  it("clears state when the session scope changes", () => {
    mount();
    fire("crew:compaction", {
      session_id: SESSION,
      phase: "completed",
      token_estimate_before: 48000,
      token_estimate_after: 12000,
      retained_count: 8,
      dropped_count: 42,
      error: null,
    });
    expect(container!.querySelector("[data-testid='compaction-indicator']")).not.toBeNull();

    // Re-render under a DIFFERENT session — the notice must not bleed.
    act(() => {
      root!.render(
        <SessionContext.Provider
          value={{ ...makeSessionCtx(), currentSessionId: "another-session" }}
        >
          <CompactionIndicator />
        </SessionContext.Provider>,
      );
    });
    expect(container!.querySelector("[data-testid='compaction-indicator']")).toBeNull();
  });

  it("progressBar clamps and rounds", () => {
    expect(progressBar(0, 8)).toBe("▱▱▱▱▱▱▱▱");
    expect(progressBar(0.5, 8)).toBe("▰▰▰▰▱▱▱▱");
    expect(progressBar(4.2, 8)).toBe("▰▰▰▰▰▰▰▰");
  });
});
