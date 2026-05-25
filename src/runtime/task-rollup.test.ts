/**
 * Pipeline task rollup tests (WEB-NEW-18).
 *
 * Covers the four cases enumerated in the bug report:
 *   1. 1 parent `run_pipeline` + 3 children → rolled to 1, parent wins
 *      the label slot.
 *   2. 2 parents with distinct `tool_call_id` each spawning children
 *      → rolled to 2.
 *   3. Pipeline parent + a non-pipeline task with NULL `tool_call_id`
 *      → rolled to 2 (null entries never collapse with each other).
 *   4. Orphan children (parent absent, only children running) → rolled
 *      to 1, label degrades to the first child's name.
 */

import { describe, expect, it } from "vitest";
import { rollupTasksByCall } from "./task-rollup";
import type { BackgroundTaskInfo } from "@/api/types";

function makeTask(
  partial: Partial<BackgroundTaskInfo> & { id: string; tool_name: string },
): BackgroundTaskInfo {
  return {
    status: "running",
    started_at: "2026-05-24T00:00:00Z",
    error: null,
    ...partial,
  };
}

describe("rollupTasksByCall", () => {
  it("folds 1 parent + 3 pipeline children into 1 entry (parent wins)", () => {
    const tasks: BackgroundTaskInfo[] = [
      makeTask({
        id: "t_parent",
        tool_name: "run_pipeline",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child_a",
        tool_name: "pipeline:analyze",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child_b",
        tool_name: "pipeline:synthesize",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child_c",
        tool_name: "pipeline:plan_and_search",
        tool_call_id: "call_A",
      }),
    ];

    const rolled = rollupTasksByCall(tasks);

    expect(rolled).toHaveLength(1);
    expect(rolled[0].id).toBe("t_parent");
    expect(rolled[0].tool_name).toBe("run_pipeline");
  });

  it("keeps 2 parents distinct when their tool_call_ids differ", () => {
    const tasks: BackgroundTaskInfo[] = [
      makeTask({
        id: "t_parent_A",
        tool_name: "run_pipeline",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child_A1",
        tool_name: "pipeline:analyze",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child_A2",
        tool_name: "pipeline:synthesize",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_parent_B",
        tool_name: "run_pipeline",
        tool_call_id: "call_B",
      }),
      makeTask({
        id: "t_child_B1",
        tool_name: "pipeline:plan_and_search",
        tool_call_id: "call_B",
      }),
      makeTask({
        id: "t_child_B2",
        tool_name: "pipeline:analyze",
        tool_call_id: "call_B",
      }),
    ];

    const rolled = rollupTasksByCall(tasks);

    expect(rolled).toHaveLength(2);
    expect(rolled.map((t) => t.id).sort()).toEqual(["t_parent_A", "t_parent_B"]);
  });

  it("treats null tool_call_id as distinct (no merging across nulls)", () => {
    const tasks: BackgroundTaskInfo[] = [
      makeTask({
        id: "t_parent",
        tool_name: "run_pipeline",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child",
        tool_name: "pipeline:analyze",
        tool_call_id: "call_A",
      }),
      // Top-level non-pipeline tasks with no tool_call_id (e.g. a
      // spawn_only podcast_generate started outside any pipeline).
      makeTask({ id: "t_podcast_1", tool_name: "podcast_generate" }),
      makeTask({ id: "t_podcast_2", tool_name: "podcast_generate" }),
    ];

    const rolled = rollupTasksByCall(tasks);

    // Parent absorbs its child; both null-tool_call_id tasks remain.
    expect(rolled).toHaveLength(3);
    expect(rolled.map((t) => t.id).sort()).toEqual([
      "t_parent",
      "t_podcast_1",
      "t_podcast_2",
    ]);
  });

  it("collapses orphan children to 1 entry when parent is absent (post-restart)", () => {
    // Post-restart case: the parent `run_pipeline` task finished or
    // was evicted from the active set; only children remain `running`.
    const tasks: BackgroundTaskInfo[] = [
      makeTask({
        id: "t_child_a",
        tool_name: "pipeline:analyze",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child_b",
        tool_name: "pipeline:synthesize",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child_c",
        tool_name: "pipeline:plan_and_search",
        tool_call_id: "call_A",
      }),
    ];

    const rolled = rollupTasksByCall(tasks);

    expect(rolled).toHaveLength(1);
    // Without a parent, the first child wins the label slot — the
    // count is still correct, just the dock label degrades to
    // `pipeline:analyze`.
    expect(rolled[0].id).toBe("t_child_a");
    expect(rolled[0].tool_name).toBe("pipeline:analyze");
  });

  it("returns [] for empty input", () => {
    expect(rollupTasksByCall([])).toEqual([]);
  });

  it("is idempotent — running it twice produces the same result", () => {
    const tasks: BackgroundTaskInfo[] = [
      makeTask({
        id: "t_parent",
        tool_name: "run_pipeline",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child",
        tool_name: "pipeline:analyze",
        tool_call_id: "call_A",
      }),
    ];
    const once = rollupTasksByCall(tasks);
    const twice = rollupTasksByCall(once);
    expect(twice).toEqual(once);
  });

  it("works even when the parent appears after children in the input order", () => {
    // Children first, parent last — server iteration order isn't
    // guaranteed to be parent-first.
    const tasks: BackgroundTaskInfo[] = [
      makeTask({
        id: "t_child_a",
        tool_name: "pipeline:analyze",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_child_b",
        tool_name: "pipeline:synthesize",
        tool_call_id: "call_A",
      }),
      makeTask({
        id: "t_parent",
        tool_name: "run_pipeline",
        tool_call_id: "call_A",
      }),
    ];

    const rolled = rollupTasksByCall(tasks);
    expect(rolled).toHaveLength(1);
    expect(rolled[0].id).toBe("t_parent");
  });
});
