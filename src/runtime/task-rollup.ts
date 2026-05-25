/**
 * Pipeline task rollup helper (WEB-NEW-18).
 *
 * Pipelines emit a parent `run_pipeline` task plus N child
 * `pipeline:<node>` tasks (e.g. `pipeline:analyze`,
 * `pipeline:synthesize`, `pipeline:plan_and_search`). The server's
 * `session/tasks.list` returns the flat set; all children share the
 * parent's `tool_call_id` so the SPA can fold them into a single
 * user-visible entry.
 *
 * Without this rollup the dock counter inflates: a 2-pipeline run
 * with 4 worker nodes each renders as "8 tasks running" instead of
 * "2 tasks running", and the constellation grows ragged.
 *
 * Rollup rules:
 *   - Group active tasks by `tool_call_id`.
 *   - Tasks with NULL/missing `tool_call_id` are kept distinct
 *     (they're top-level non-pipeline tasks) — keyed by `__no_call:<id>`
 *     so two null-tool_call_id tasks never collapse into one.
 *   - Within a group, prefer the parent (`tool_name === "run_pipeline"`
 *     or any name without the `pipeline:` prefix) so the dock label
 *     says "run_pipeline" not "pipeline:analyze". If the parent is
 *     absent (post-restart orphan case where only children remain
 *     active), fall back to the first child — the label degrades to
 *     `pipeline:analyze` but the count is still rolled up to 1.
 */

import type { BackgroundTaskInfo } from "@/api/types";

function isPipelineChild(task: BackgroundTaskInfo): boolean {
  return task.tool_name.startsWith("pipeline:");
}

/** Synthesize a rollup key that never collides across null entries. */
function rollupKey(task: BackgroundTaskInfo): string {
  return task.tool_call_id ?? `__no_call:${task.id}`;
}

/**
 * Fold pipeline children under the parent `run_pipeline` task by
 * `tool_call_id`. The returned list preserves the input order of each
 * group's representative (parent first, else first child seen).
 */
export function rollupTasksByCall(
  tasks: BackgroundTaskInfo[],
): BackgroundTaskInfo[] {
  const byKey = new Map<string, BackgroundTaskInfo>();
  for (const task of tasks) {
    const key = rollupKey(task);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, task);
      continue;
    }
    // Parent wins over child. If the existing entry is a pipeline
    // child and the incoming task is not, swap. Otherwise keep the
    // first-seen entry.
    if (isPipelineChild(existing) && !isPipelineChild(task)) {
      byKey.set(key, task);
    }
  }
  return [...byKey.values()];
}
