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
import {
  aggregateCallStatus,
  displayLabelForRolled,
  rollupTasksByCall,
} from "./task-rollup";
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

describe("aggregateCallStatus", () => {
  const CALL = "tc-agg";

  it("reports active while any member is spawned/running", () => {
    const tasks = [
      makeTask({
        id: "a",
        tool_name: "pipeline:analyze",
        tool_call_id: CALL,
        status: "failed",
      }),
      makeTask({
        id: "b",
        tool_name: "pipeline:synthesize",
        tool_call_id: CALL,
        status: "running",
      }),
    ];
    expect(aggregateCallStatus(tasks, CALL)).toBe("active");
  });

  it("honors the parent's successful outcome over a retained failed child (recovered pipeline)", () => {
    // codex round 4: a pipeline can recover from a node failure (failure
    // edges, retries, continue_on_error) — the failed child row remains
    // in the store while the parent completes successfully. The parent's
    // outcome must win, or a successful run renders as an error.
    const tasks = [
      makeTask({
        id: "child-f",
        tool_name: "pipeline:analyze",
        tool_call_id: CALL,
        status: "failed",
      }),
      makeTask({
        id: "parent",
        tool_name: "run_pipeline",
        tool_call_id: CALL,
        status: "completed",
      }),
    ];
    expect(aggregateCallStatus(tasks, CALL)).toBe("settled");
  });

  it("reports failed when the parent itself failed", () => {
    const tasks = [
      makeTask({
        id: "child-ok",
        tool_name: "pipeline:analyze",
        tool_call_id: CALL,
        status: "completed",
      }),
      makeTask({
        id: "parent",
        tool_name: "run_pipeline",
        tool_call_id: CALL,
        status: "failed",
      }),
    ];
    expect(aggregateCallStatus(tasks, CALL)).toBe("failed");
  });

  it("falls back to child aggregation when no parent remains (orphan case)", () => {
    const tasks = [
      makeTask({
        id: "c1",
        tool_name: "pipeline:analyze",
        tool_call_id: CALL,
        status: "completed",
      }),
      makeTask({
        id: "c2",
        tool_name: "pipeline:synthesize",
        tool_call_id: CALL,
        status: "failed",
      }),
    ];
    expect(aggregateCallStatus(tasks, CALL)).toBe("failed");
  });

  it("the newest parent by started_at wins over a failed predecessor, regardless of list order", () => {
    // codex round 5 P1: TaskStore.getTasks orders newest-first, so list
    // position must not decide — a relaunched parent must supersede its
    // failed predecessor under BOTH orderings.
    const older = makeTask({
      id: "parent-old",
      tool_name: "run_pipeline",
      tool_call_id: CALL,
      status: "failed",
      started_at: "2026-07-10T00:00:00Z",
    });
    const newer = makeTask({
      id: "parent-new",
      tool_name: "run_pipeline",
      tool_call_id: CALL,
      status: "completed",
      started_at: "2026-07-10T01:00:00Z",
    });
    // Production (store) ordering: newest first.
    expect(aggregateCallStatus([newer, older], CALL)).toBe("settled");
    // Chronological ordering: oldest first.
    expect(aggregateCallStatus([older, newer], CALL)).toBe("settled");
    // Inverse case: the RELAUNCH failed while the predecessor succeeded.
    const newerFailed = makeTask({
      id: "parent-new-f",
      tool_name: "run_pipeline",
      tool_call_id: CALL,
      status: "failed",
      started_at: "2026-07-10T01:00:00Z",
    });
    const olderOk = makeTask({
      id: "parent-old-ok",
      tool_name: "run_pipeline",
      tool_call_id: CALL,
      status: "completed",
      started_at: "2026-07-10T00:00:00Z",
    });
    expect(aggregateCallStatus([newerFailed, olderOk], CALL)).toBe("failed");
  });

  it("keeps any-failure aggregation for mixed-tool non-pipeline groups (no member masking)", () => {
    // codex round 5 P2: DIFFERENT ordinary tools sharing a call id have
    // no lineage relationship — one member's success must not mask
    // another member's failure.
    const tasks = [
      makeTask({
        id: "ord-ok",
        tool_name: "podcast_generate",
        tool_call_id: CALL,
        status: "completed",
        started_at: "2026-07-10T01:00:00Z",
      }),
      makeTask({
        id: "ord-fail",
        tool_name: "fm_tts",
        tool_call_id: CALL,
        status: "failed",
        started_at: "2026-07-10T00:00:00Z",
      }),
    ];
    expect(aggregateCallStatus(tasks, CALL)).toBe("failed");
  });

  it("a successful same-tool relaunch supersedes its failed predecessor (newest wins)", () => {
    // codex round 6 P2: TaskSupervisor::relaunch registers the successor
    // with the SAME tool_call_id and tool_name. The retained failed
    // predecessor must not fail the card once the relaunch settles.
    const failedOld = makeTask({
      id: "tts-old",
      tool_name: "fm_tts",
      tool_call_id: CALL,
      status: "failed",
      started_at: "2026-07-10T00:00:00Z",
    });
    const relaunchOk = makeTask({
      id: "tts-new",
      tool_name: "fm_tts",
      tool_call_id: CALL,
      status: "completed",
      started_at: "2026-07-10T01:00:00Z",
    });
    // Both store (newest-first) and chronological orderings.
    expect(aggregateCallStatus([relaunchOk, failedOld], CALL)).toBe("settled");
    expect(aggregateCallStatus([failedOld, relaunchOk], CALL)).toBe("settled");
    // Inverse: the relaunch itself failed after a completed predecessor.
    const relaunchBad = makeTask({
      id: "tts-new-f",
      tool_name: "fm_tts",
      tool_call_id: CALL,
      status: "failed",
      started_at: "2026-07-10T02:00:00Z",
    });
    const okOld = makeTask({
      id: "tts-old-ok",
      tool_name: "fm_tts",
      tool_call_id: CALL,
      status: "completed",
      started_at: "2026-07-10T00:30:00Z",
    });
    expect(aggregateCallStatus([relaunchBad, okOld], CALL)).toBe("failed");
  });

  it("returns null when no member carries the call id", () => {
    expect(
      aggregateCallStatus(
        [makeTask({ id: "x", tool_name: "podcast_generate" })],
        CALL,
      ),
    ).toBe(null);
  });
});
