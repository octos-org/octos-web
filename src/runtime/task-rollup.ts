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
 *   - Only collapse groups whose `tool_call_id` actually belongs to a
 *     pipeline family — i.e. the group must contain a
 *     `run_pipeline` parent OR at least one `pipeline:*` child. Two
 *     unrelated non-pipeline tasks that happened to share the same
 *     `tool_call_id` are left alone (defensive against future server
 *     fanouts that reuse the field).
 *   - Group keys are prefix-tagged (`call:<id>` vs `no_call:<id>`) so a
 *     real `tool_call_id` literally equal to `no_call:xyz` cannot
 *     collide with a null-tool_call_id task whose id is `xyz`.
 *   - Within a pipeline group, prefer the parent (`tool_name ===
 *     "run_pipeline"` or any name without the `pipeline:` prefix) so
 *     the dock label says "run_pipeline" not "pipeline:analyze". If the
 *     parent is absent (post-restart orphan case where only children
 *     remain active), fall back to the first child — the count is
 *     still rolled up to 1; the consumer is responsible for prettifying
 *     the child label (see `displayLabelForRolled`).
 */

import type { BackgroundTaskInfo } from "@/api/types";

const NULL_CALL_TAG = "no_call:";
const CALL_TAG = "call:";

function isPipelineChild(task: BackgroundTaskInfo): boolean {
  return task.tool_name.startsWith("pipeline:");
}

function isPipelineParent(task: BackgroundTaskInfo): boolean {
  return task.tool_name === "run_pipeline";
}

/** Synthesize a rollup key that never collides across null entries. */
function rollupKey(task: BackgroundTaskInfo): string {
  return task.tool_call_id != null
    ? `${CALL_TAG}${task.tool_call_id}`
    : `${NULL_CALL_TAG}${task.id}`;
}

/**
 * Fold pipeline children under the parent `run_pipeline` task by
 * `tool_call_id`. The returned list preserves the input order of each
 * group's representative (parent first, else first child seen).
 *
 * Groups that are NOT pipeline families (no `run_pipeline` parent and
 * no `pipeline:*` child) are emitted unchanged — every member appears
 * individually in the output, so two unrelated tasks sharing a
 * `tool_call_id` won't silently collapse.
 */
export function rollupTasksByCall(
  tasks: BackgroundTaskInfo[],
): BackgroundTaskInfo[] {
  // Partition into groups by rollup key, preserving group order via the
  // insertion order of `Map`.
  const groups = new Map<string, BackgroundTaskInfo[]>();
  for (const task of tasks) {
    const key = rollupKey(task);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [task]);
    } else {
      bucket.push(task);
    }
  }

  const out: BackgroundTaskInfo[] = [];
  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      out.push(bucket[0]);
      continue;
    }
    const isPipelineGroup = bucket.some(
      (t) => isPipelineParent(t) || isPipelineChild(t),
    );
    if (!isPipelineGroup) {
      // Defensive: don't collapse unrelated tasks even if they share a
      // `tool_call_id`. Emit each one.
      out.push(...bucket);
      continue;
    }
    // Pipeline family — collapse to one representative. Prefer the
    // parent (`run_pipeline`, or any non-`pipeline:*` member) over a
    // child. If only children are present, take the first child as the
    // representative (orphan case).
    const parent = bucket.find((t) => !isPipelineChild(t));
    out.push(parent ?? bucket[0]);
  }
  return out;
}

/**
 * Produce a user-friendly label for a rolled-up task. For pipeline
 * children (the orphan-parent case) this strips the `pipeline:`
 * prefix and falls back to `Pipeline` if the suffix is empty. The
 * dock and Slides/Sites indicators call this so the orphan rendering
 * isn't `pipeline:analyze running` but `Analyze running`.
 */
export function displayLabelForRolled(task: BackgroundTaskInfo): string {
  if (isPipelineChild(task)) {
    const suffix = task.tool_name.slice("pipeline:".length).trim();
    return suffix.length === 0 ? "Pipeline" : suffix.replace(/_/gu, " ");
  }
  return task.tool_name.replace(/_/gu, " ");
}
