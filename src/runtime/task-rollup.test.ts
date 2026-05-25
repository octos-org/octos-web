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
import { displayLabelForRolled, rollupTasksByCall } from "./task-rollup";
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

  it("does not collapse non-pipeline tasks that happen to share a tool_call_id", () => {
    // Defensive: if the server ever fans out two unrelated non-
    // pipeline tasks with the same `tool_call_id` we must not silently
    // drop one. Only pipeline families (with a `run_pipeline` parent
    // OR a `pipeline:*` child) collapse.
    const tasks: BackgroundTaskInfo[] = [
      makeTask({
        id: "t_a",
        tool_name: "podcast_generate",
        tool_call_id: "shared_call",
      }),
      makeTask({
        id: "t_b",
        tool_name: "deep_research",
        tool_call_id: "shared_call",
      }),
    ];
    const rolled = rollupTasksByCall(tasks);
    expect(rolled).toHaveLength(2);
    expect(rolled.map((t) => t.id).sort()).toEqual(["t_a", "t_b"]);
  });

  it("does NOT collide a real tool_call_id of `no_call:<id>` with a null-tool_call_id task", () => {
    // Codex review fence-post: keys are prefix-tagged (`call:` vs
    // `no_call:`) so a literal `tool_call_id === "no_call:abc"` and a
    // null-tool_call_id task with `id === "abc"` must remain distinct.
    const tasks: BackgroundTaskInfo[] = [
      makeTask({
        id: "abc",
        tool_name: "podcast_generate",
        // tool_call_id intentionally omitted (null).
      }),
      makeTask({
        id: "other",
        tool_name: "deep_research",
        tool_call_id: "no_call:abc",
      }),
    ];
    const rolled = rollupTasksByCall(tasks);
    expect(rolled).toHaveLength(2);
    expect(rolled.map((t) => t.id).sort()).toEqual(["abc", "other"]);
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

describe("displayLabelForRolled", () => {
  function t(tool_name: string): BackgroundTaskInfo {
    return {
      id: "t",
      tool_name,
      status: "running",
      started_at: "2026-05-24T00:00:00Z",
      error: null,
    };
  }

  it("strips the `pipeline:` prefix and spaces underscores", () => {
    expect(displayLabelForRolled(t("pipeline:analyze"))).toBe("analyze");
    expect(displayLabelForRolled(t("pipeline:plan_and_search"))).toBe(
      "plan and search",
    );
  });

  it("falls back to `Pipeline` when `pipeline:` suffix is empty", () => {
    // Defensive: a malformed `pipeline:` with no node name shouldn't
    // render as an empty string.
    expect(displayLabelForRolled(t("pipeline:"))).toBe("Pipeline");
    expect(displayLabelForRolled(t("pipeline:   "))).toBe("Pipeline");
  });

  it("returns the tool_name with underscores spaced for non-pipeline tasks", () => {
    expect(displayLabelForRolled(t("run_pipeline"))).toBe("run pipeline");
    expect(displayLabelForRolled(t("podcast_generate"))).toBe(
      "podcast generate",
    );
  });
});
