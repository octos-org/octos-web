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

describe("SessionTaskIndicator — pipeline child rollup (WEB-NEW-18)", () => {
  // Repro: server emits 1 parent `run_pipeline` plus N child
  // `pipeline:<node>` tasks all sharing one `tool_call_id`. Pre-fix the
  // dock counted every entry, so 2 real pipelines inflated to 5–9.
  // Post-fix: the dock rolls children under the parent by
  // `tool_call_id`.

  function seedRawTasks(tasks: BackgroundTaskInfo[]): void {
    act(() => {
      TaskStore.replaceTasks(SESSION, tasks);
    });
  }

  function makePipelineFamily(
    callId: string,
    children: string[],
    parentTime: number,
  ): BackgroundTaskInfo[] {
    const family: BackgroundTaskInfo[] = [
      {
        id: `parent-${callId}`,
        tool_name: "run_pipeline",
        tool_call_id: callId,
        status: "running",
        started_at: new Date(2026, 0, 1, 0, 0, parentTime).toISOString(),
        completed_at: null,
        output_files: [],
        error: null,
      },
    ];
    children.forEach((node, idx) => {
      family.push({
        id: `child-${callId}-${idx}`,
        tool_name: `pipeline:${node}`,
        tool_call_id: callId,
        status: "running",
        started_at: new Date(2026, 0, 1, 0, 0, parentTime + idx + 1).toISOString(),
        completed_at: null,
        output_files: [],
        error: null,
      });
    });
    return family;
  }

  it("counts 1 parent + 3 children as a single dock entry", () => {
    seedRawTasks(
      makePipelineFamily("call_A", ["analyze", "synthesize", "plan_and_search"], 0),
    );

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <SessionTaskIndicator />
      </SessionContext.Provider>,
    );

    const indicator = harness.container.querySelector(
      "[data-testid='session-task-indicator']",
    );
    expect(indicator).not.toBeNull();
    expect(indicator!.getAttribute("data-task-count")).toBe("1");
    // Single-active branch renders the parent's tool_name in the label.
    expect(indicator!.textContent).toContain("run pipeline running");

    harness.unmount();
  });

  it("counts 2 parents with distinct tool_call_ids as 2 dock entries", () => {
    seedRawTasks([
      ...makePipelineFamily("call_A", ["analyze", "synthesize"], 0),
      ...makePipelineFamily("call_B", ["plan_and_search", "analyze", "synthesize"], 30),
    ]);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <SessionTaskIndicator />
      </SessionContext.Provider>,
    );

    const indicator = harness.container.querySelector(
      "[data-testid='session-task-indicator']",
    );
    expect(indicator).not.toBeNull();
    expect(indicator!.getAttribute("data-task-count")).toBe("2");
    expect(indicator!.textContent).toContain("2 tasks running");

    harness.unmount();
  });

  it("keeps a pipeline parent + a null-tool_call_id task as 2 entries", () => {
    seedRawTasks([
      ...makePipelineFamily("call_A", ["analyze", "synthesize"], 0),
      // Non-pipeline spawn_only task with no tool_call_id (e.g. an
      // out-of-band podcast_generate).
      {
        id: "task-standalone",
        tool_name: "podcast_generate",
        status: "running",
        started_at: new Date(2026, 0, 1, 0, 1, 0).toISOString(),
        completed_at: null,
        output_files: [],
        error: null,
      },
    ]);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <SessionTaskIndicator />
      </SessionContext.Provider>,
    );

    const indicator = harness.container.querySelector(
      "[data-testid='session-task-indicator']",
    );
    expect(indicator).not.toBeNull();
    expect(indicator!.getAttribute("data-task-count")).toBe("2");

    harness.unmount();
  });

  it("rolls orphan children (parent completed, children still running) to 1 entry", () => {
    // Post-restart case: the parent row is no longer in the active set
    // (status=completed or absent). Pre-fix the dock would show "3
    // tasks running"; post-fix the three children collapse to 1.
    seedRawTasks([
      {
        id: "parent-orphan",
        tool_name: "run_pipeline",
        tool_call_id: "call_orphan",
        status: "completed",
        started_at: new Date(2026, 0, 1, 0, 0, 0).toISOString(),
        completed_at: new Date(2026, 0, 1, 0, 0, 10).toISOString(),
        output_files: [],
        error: null,
      },
      {
        id: "child-orphan-0",
        tool_name: "pipeline:analyze",
        tool_call_id: "call_orphan",
        status: "running",
        started_at: new Date(2026, 0, 1, 0, 0, 1).toISOString(),
        completed_at: null,
        output_files: [],
        error: null,
      },
      {
        id: "child-orphan-1",
        tool_name: "pipeline:synthesize",
        tool_call_id: "call_orphan",
        status: "running",
        started_at: new Date(2026, 0, 1, 0, 0, 2).toISOString(),
        completed_at: null,
        output_files: [],
        error: null,
      },
      {
        id: "child-orphan-2",
        tool_name: "pipeline:plan_and_search",
        tool_call_id: "call_orphan",
        status: "running",
        started_at: new Date(2026, 0, 1, 0, 0, 3).toISOString(),
        completed_at: null,
        output_files: [],
        error: null,
      },
    ]);

    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx()}>
        <SessionTaskIndicator />
      </SessionContext.Provider>,
    );

    const indicator = harness.container.querySelector(
      "[data-testid='session-task-indicator']",
    );
    expect(indicator).not.toBeNull();
    expect(indicator!.getAttribute("data-task-count")).toBe("1");
    // Label degrades to a prettified child name (the parent is
    // `completed` and therefore not in the active set). TaskStore
    // sorts by started_at DESC so the exact child shown depends on
    // the store's ordering — assert only that we render an orphan
    // pipeline label (no `pipeline:` prefix, no parent's
    // `run_pipeline`). The count being correct is the load-bearing
    // assertion.
    expect(indicator!.textContent).toMatch(
      /(analyze|synthesize|plan and search) running/u,
    );
    expect(indicator!.textContent).not.toContain("pipeline:");
    expect(indicator!.textContent).not.toContain("run pipeline running");

    harness.unmount();
  });
});
