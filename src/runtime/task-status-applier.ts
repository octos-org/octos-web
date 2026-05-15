/**
 * Apply `crew:task_status` payloads to ThreadStore.
 *
 * Extracted from `runtime-provider.tsx` so unit tests can exercise the
 * same code path the live effect uses without mounting the provider,
 * and so the `.tsx` host file stays component-only (react-refresh
 * `only-export-components` boundary).
 *
 * Background subagents (e.g. `deep_research` / `run_pipeline`) emit
 * their per-step `tool_progress` SSE events on the spawned task's own
 * stream, not the parent chat stream. Without this mirror the
 * tool-call bubble in the parent thread renders empty even when the
 * task is actively running, and never clears its spinner when the
 * task settles (codex 2026-05-15 live-event variant).
 */

import * as ThreadStore from "@/store/thread-store";
import type { BackgroundTaskInfo } from "@/api/types";

/** Last task_status seen per `task.id`. Used to suppress synthesizing a
 *  duplicate progress line on replays/oscillations — only emit a line
 *  when the status actually changes for that task. Per-task scoping
 *  also means two unrelated tasks sharing one `tool_call_id` (rare but
 *  possible across reconnects) each contribute exactly one entry per
 *  transition rather than collapsing into the previous task's line.
 */
const lastTaskStatusById = new Map<string, BackgroundTaskInfo["status"]>();

/** Cap individual task labels and error suffixes so a pathological
 *  payload cannot bloat the in-bubble timeline. The bubble renders
 *  monospace at small text sizes — long single-line failures are
 *  unreadable. */
const MAX_TASK_LABEL_CHARS = 64;
const MAX_PROGRESS_LINE_CHARS = 320;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Display-form a snake_case tool name. Mirrors the simplification in
 *  `session-task-dock.tsx`'s `taskDisplayName` so the same task surfaces
 *  with the same label everywhere ("deep_research" → "deep research").
 *  Capped to a reasonable width. */
function displayTaskName(tool: string): string {
  const stripped = (tool || "task").replace(/_/g, " ").trim();
  return clip(stripped || "task", MAX_TASK_LABEL_CHARS);
}

/** Build a human-readable progress line for a task_status transition.
 *  Returns null when the status carries no useful narration (e.g. the
 *  daemon emitted an unknown status string), or when this exact status
 *  was already seen for this task and a duplicate line should be
 *  suppressed at the source. */
function synthesizeTaskProgressLine(
  task: BackgroundTaskInfo,
): string | null {
  const previous = lastTaskStatusById.get(task.id);
  if (previous === task.status) return null;
  // Record the new status BEFORE returning the line so re-entrant
  // dispatches (within the same tick) can short-circuit on the second
  // call. Failures still record so a `failed -> failed` replay is
  // suppressed too.
  lastTaskStatusById.set(task.id, task.status);

  const label = displayTaskName(task.tool_name);
  switch (task.status) {
    case "spawned":
      return clip(`${label} started`, MAX_PROGRESS_LINE_CHARS);
    case "running":
      return clip(`${label} running`, MAX_PROGRESS_LINE_CHARS);
    case "completed":
      return clip(`${label} completed`, MAX_PROGRESS_LINE_CHARS);
    case "failed": {
      // Single-line normalize the error: collapse newlines/whitespace
      // so the bubble doesn't line-break inside a tiny mono pill.
      const detail = task.error
        ? task.error.replace(/\s+/g, " ").trim()
        : "";
      const line = detail ? `${label} failed: ${detail}` : `${label} failed`;
      return clip(line, MAX_PROGRESS_LINE_CHARS);
    }
    default:
      return null;
  }
}

/** Reset the per-task status-dedupe map. Tests call this between
 *  cases so a transition seen in one case can re-fire in the next. */
export function __resetTaskStatusDedupForTest(): void {
  lastTaskStatusById.clear();
}

/** Apply a `crew:task_status` payload to ThreadStore: synthesize a
 *  progress line into the tool call's timeline, and flip the
 *  originating tool call's terminal status (`complete` / `error`).
 *  Bug 2026-05-15 (codex live-event variant): the synthetic progress
 *  line at this site says "completed" / "failed" — but pre-fix nobody
 *  updated `toolCall.status`, so every spinner gated on
 *  `status === "running"` kept spinning. This is the live counterpart
 *  to the `handleSpawnComplete` gap in
 *  `ui-protocol-event-router.ts`. */
export function applyTaskStatusToThreadStore(
  sessionId: string,
  topic: string | undefined,
  task: BackgroundTaskInfo,
): void {
  const progressLine = synthesizeTaskProgressLine(task);
  if (!progressLine || !task.tool_call_id) return;
  // Mirror into the thread store when it already knows about this
  // tool_call_id (i.e. tool_start arrived before task_status). When
  // the lookup misses we deliberately drop the synthetic progress
  // rather than synthesize an orphan thread — creating phantom
  // threads for every backgrounded task on first paint would race
  // with the real tool_start that arrives moments later.
  const threadId = ThreadStore.findThreadIdForToolCall(
    sessionId,
    topic,
    task.tool_call_id,
  );
  if (!threadId) return;
  ThreadStore.appendToolProgress(threadId, task.tool_call_id, progressLine);
  // Mirror the terminal status into ThreadStore so the spinner clears
  // on the same tick the progress line says "done". Non-terminal
  // `spawned`/`running` lines do NOT flip status (the chip is
  // correctly running during those frames).
  if (task.status === "completed") {
    ThreadStore.setToolCallStatus(threadId, task.tool_call_id, "complete");
  } else if (task.status === "failed") {
    ThreadStore.setToolCallStatus(threadId, task.tool_call_id, "error");
  }
}
