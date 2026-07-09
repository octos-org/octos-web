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
import * as TaskStore from "@/store/task-store";
import { aggregateCallStatus } from "@/runtime/task-rollup";
import type { BackgroundTaskInfo } from "@/api/types";

/** Narration dedupe: last task_status whose progress LINE landed, per
 *  `task.id`. Suppresses re-synthesizing the same line on replays /
 *  poll re-dispatches — only emit a line when the status actually
 *  changes for that task. Per-task scoping also means two unrelated
 *  tasks sharing one `tool_call_id` (rare but possible across
 *  reconnects) each contribute exactly one entry per transition rather
 *  than collapsing into the previous task's line.
 *
 *  codex round 4: this is deliberately a SEPARATE map from the flip
 *  dedupe below. A terminal row deferred on an active pipeline sibling
 *  must keep re-evaluating the aggregate every poll tick (flip map not
 *  recorded) WITHOUT re-narrating its line each tick — two deferred
 *  terminal rows alternate lines that bypass `appendToolProgress`'s
 *  consecutive-only dedupe and would evict real progress from the
 *  bounded timeline. */
const lastNarratedStatusById = new Map<string, BackgroundTaskInfo["status"]>();

/** Flip dedupe: last task_status whose terminal status flip (or
 *  non-terminal pass-through) fully APPLIED, per `task.id`. Recorded
 *  only after `setToolCallStatus` confirms application (or on
 *  non-terminal frames), so a no-oped or deferred flip retries on the
 *  next poll tick. */
const lastAppliedStatusById = new Map<string, BackgroundTaskInfo["status"]>();

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
 *  was already seen (`previous`) and a duplicate line should be
 *  suppressed at the source.
 *
 *  Bug 2026-05-15 (codex final-3 gap 3): does NOT record the dedupe
 *  entry here — the caller MUST record only AFTER the append actually
 *  landed on a resolved thread. Pre-fix this function wrote the dedupe
 *  before the lookup at the call site succeeded, so a later retry of
 *  the same terminal task was silently suppressed. */
function synthesizeTaskProgressLine(
  task: BackgroundTaskInfo,
  previous: BackgroundTaskInfo["status"] | undefined,
): string | null {
  if (previous === task.status) return null;

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

/** Reset the per-task status-dedupe maps. Tests call this between
 *  cases so a transition seen in one case can re-fire in the next. */
export function __resetTaskStatusDedupForTest(): void {
  lastNarratedStatusById.clear();
  lastAppliedStatusById.clear();
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
  if (!task.tool_call_id) return;
  const previousNarrated = lastNarratedStatusById.get(task.id);
  const lineIsNew = previousNarrated !== task.status;
  const progressLine = lineIsNew
    ? synthesizeTaskProgressLine(task, previousNarrated)
    : null;
  // A fresh status that synthesizes NO line is an unknown status string —
  // nothing to narrate or flip (pre-split behavior preserved).
  if (lineIsNew && progressLine === null) return;
  const flipIsNew = lastAppliedStatusById.get(task.id) !== task.status;
  if (!lineIsNew && !flipIsNew) return;
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
  if (!threadId) {
    // Bug 2026-05-15 (codex final-3 gap 3): DO NOT record any dedupe
    // entry — the lookup missed, so a later retry of the same
    // `completed`/`failed` task MUST be allowed to try again. The
    // task watcher's poll loop re-fires the same row on every tick,
    // and the originating `tool/started` may not have landed yet when
    // the first attempt arrived.
    return;
  }
  if (progressLine !== null) {
    ThreadStore.appendToolProgress(threadId, task.tool_call_id, progressLine);
    // Narration dedupe records as soon as the line lands — even when the
    // terminal flip below defers — so re-polled deferred rows do not
    // re-narrate every tick (codex round 4).
    lastNarratedStatusById.set(task.id, task.status);
  }
  // Mirror the terminal status into ThreadStore so the spinner clears
  // on the same tick the progress line says "done". Non-terminal
  // `spawned`/`running` lines do NOT flip status (the chip is
  // correctly running during those frames).
  //
  // Bug 2026-05-15 (codex final-3 gap 3): record the flip dedupe entry
  // ONLY AFTER `setToolCallStatus` confirms it actually applied.
  // `setToolCallStatus` returns `true` when it found the target tool
  // call and flipped its status, `false` when the lookup no-oped. If
  // the status flip no-ops (tool call not in store yet, picker
  // missed, etc.) the next retry should be allowed to try again.
  let applied = true;
  if (task.status === "completed" || task.status === "failed") {
    // codex round 3: pipeline members share this tool_call_id but the
    // watcher dispatches each raw row separately — flipping the card on
    // the FIRST terminal member freezes it while siblings still run
    // (same deferral the live `task/updated` router path applies). The
    // watcher calls `TaskStore.replaceTasks` BEFORE dispatching
    // `crew:task_status`, so the store reflects this poll's snapshot.
    // While a sibling is active, skip the flip; the LAST member's
    // transition settles the card with the aggregate outcome (an
    // earlier failed row is retained by the store, so the failure
    // outcome survives the deferral).
    const aggregate =
      aggregateCallStatus(
        TaskStore.getTasks(sessionId, topic),
        task.tool_call_id,
      ) ?? (task.status === "failed" ? "failed" : "settled");
    if (aggregate === "active") {
      // Do NOT record the flip dedupe: the next poll tick re-fires this
      // terminal row and re-evaluates the aggregate, so the card still
      // settles even if the last sibling's own terminal row is never
      // observed (self-healing). The narration dedupe above already
      // recorded, so the retry is silent.
      return;
    }
    applied = ThreadStore.setToolCallStatus(
      threadId,
      task.tool_call_id,
      aggregate === "failed" ? "error" : "complete",
    );
  }
  // Non-terminal `spawned`/`running` lines always count as applied
  // (the progress line itself landed; no status flip required).
  if (applied) {
    lastAppliedStatusById.set(task.id, task.status);
  }
}
