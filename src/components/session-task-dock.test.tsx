/**
 * `SessionTaskIndicator` constellation overflow tests.
 *
 * codex PR #147 review (MINOR 2, 2026-05-22): the header constellation
 * had no dot cap — 20+ active background tasks would render 20+ dots
 * and blow past the header's `42vw` max-width. Fix: render the first
 * (MAX_VISIBLE_DOTS - 1) dots followed by a "+N" overflow chip whose
 * `data-testid='task-constellation-overflow'` makes the cap testable.
 *
 * `data-task-count` on the outer container still reflects the REAL
 * count (no cap) so existing screenshots / spec strings keep their
 * arithmetic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { SessionTaskIndicator } from "./session-task-dock";
import { SessionContext } from "@/runtime/session-context";
import type { SessionContextValue } from "@/runtime/session-context";
import * as TaskStore from "@/store/task-store";
import type { BackgroundTaskInfo } from "@/api/types";

const SESSION = "sess-task-dock-overflow";

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

function makeTask(i: number): BackgroundTaskInfo {
  return {
    id: `task-${i}`,
    tool_name: "podcast_generate",
    tool_call_id: `tc-${i}`,
    status: "running",
    started_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    completed_at: null,
    output_files: [],
    error: null,
  };
}

function seedTasks(n: number): void {
  const tasks: BackgroundTaskInfo[] = [];
  for (let i = 0; i < n; i += 1) tasks.push(makeTask(i));
  TaskStore.replaceTasks(SESSION, tasks);
}

beforeEach(() => {
  TaskStore.clearTasks(SESSION);
});

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  TaskStore.clearTasks(SESSION);
});

describe("SessionTaskIndicator — constellation dot cap", () => {
  it("renders a dot per task when the count fits under the cap", () => {
    seedTasks(5);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <SessionTaskIndicator />
      </SessionContext.Provider>,
    );

    const indicator = harness.container.querySelector(
      "[data-testid='session-task-indicator']",
    );
    expect(indicator).not.toBeNull();
    // `data-task-count` mirrors the actual count (no cap).
    expect(indicator!.getAttribute("data-task-count")).toBe("5");

    const dots = indicator!.querySelectorAll(".task-constellation-dot");
    expect(dots.length).toBe(5);

    // No overflow chip needed when count is under cap.
    expect(
      indicator!.querySelector("[data-testid='task-constellation-overflow']"),
    ).toBeNull();

    harness.unmount();
  });

  it("caps visible dots and renders a `+N` overflow chip when count exceeds the cap (codex PR #147 MINOR 2, 2026-05-22)", () => {
    // 20 active tasks — pre-fix would render 20 dots, blowing past the
    // header `42vw` max-width. Post-fix: 7 dots + a `+13` chip.
    seedTasks(20);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <SessionTaskIndicator />
      </SessionContext.Provider>,
    );

    const indicator = harness.container.querySelector(
      "[data-testid='session-task-indicator']",
    );
    expect(indicator).not.toBeNull();
    // `data-task-count` still reports the REAL count.
    expect(indicator!.getAttribute("data-task-count")).toBe("20");

    const dots = indicator!.querySelectorAll(".task-constellation-dot");
    // MAX_VISIBLE_DOTS = 8, so 7 dots remain plus one overflow chip in
    // the eighth slot.
    expect(dots.length).toBe(7);

    const overflow = indicator!.querySelector(
      "[data-testid='task-constellation-overflow']",
    );
    expect(overflow).not.toBeNull();
    expect(overflow!.textContent).toBe("+13");

    harness.unmount();
  });

  it("renders exactly the cap of dots and no overflow chip when count == MAX_VISIBLE_DOTS", () => {
    // Edge case: 8 tasks → exactly the cap → 8 dots, no overflow.
    seedTasks(8);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <SessionTaskIndicator />
      </SessionContext.Provider>,
    );

    const indicator = harness.container.querySelector(
      "[data-testid='session-task-indicator']",
    );
    expect(indicator).not.toBeNull();
    expect(indicator!.getAttribute("data-task-count")).toBe("8");

    const dots = indicator!.querySelectorAll(".task-constellation-dot");
    expect(dots.length).toBe(8);
    expect(
      indicator!.querySelector("[data-testid='task-constellation-overflow']"),
    ).toBeNull();

    harness.unmount();
  });
});
