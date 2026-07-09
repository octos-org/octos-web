/**
 * Header autonomy chip: active recurring loops + persisted goal for the
 * current session, with stop controls (M15 `coding.loop_runtime.v1` /
 * `coding.goal_runtime.v1`; web parity P2).
 *
 * Why: a paused-loop "Re-entering" zombie (octos #1576) was invisible on
 * the web — the TUI showed a chip, the SPA showed nothing, so a runaway
 * or stuck loop could only be found and stopped from a terminal. This
 * chip makes session autonomy visible and stoppable in place.
 *
 * Reads `autonomy-store` (snapshot on connect + live loop/goal
 * notifications). Renders nothing when the scope has no live loop or
 * goal, so non-autonomous sessions pay zero header pixels.
 */

import { useEffect, useState } from "react";
import { Repeat2 , Target } from "lucide-react";
import type { UiLoopRecord } from "@/runtime/ui-protocol-types";
import { useSession } from "@/runtime/session-context";
import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import {
  removeLoop,
  setGoal,
  upsertLoop,
  useAutonomyState,
} from "@/store/autonomy-store";

/** Terminal loop statuses the chip should not count as live. The server
 *  filters `deleted` from `loop/list` already; `completed`/`expired`
 *  arrive via `loop/completed` records. */
const TERMINAL_LOOP_STATUSES = new Set(["deleted", "completed", "expired"]);

function isLiveLoop(l: UiLoopRecord): boolean {
  return !TERMINAL_LOOP_STATUSES.has(l.status);
}

function isLiveGoal(status: string): boolean {
  return status === "active" || status === "paused";
}

function clip(text: string, max = 60): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function relativeNextRun(nextRunAtMs: number | null | undefined): string | null {
  if (typeof nextRunAtMs !== "number") return null;
  const deltaSec = Math.round((nextRunAtMs - Date.now()) / 1000);
  if (deltaSec <= 0) return "due now";
  if (deltaSec < 90) return `next in ${deltaSec}s`;
  if (deltaSec < 5400) return `next in ${Math.round(deltaSec / 60)}m`;
  return `next in ${Math.round(deltaSec / 3600)}h`;
}

export function SessionAutonomyChip() {
  const { currentSessionId, historyTopic } = useSession();
  const { loops, goal } = useAutonomyState(currentSessionId, historyTopic);
  const [open, setOpen] = useState(false);
  // Loop ids (or "goal") with an in-flight control RPC.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  // Delete/clear are destructive → two-click confirm per row id.
  const [armed, setArmed] = useState<string | null>(null);

  // Menu state must not survive a session/topic switch (codex #260
  // review class: destructive UI rendered over a different session).
  useEffect(() => {
    setOpen(false);
    setBusy({});
    setArmed(null);
  }, [currentSessionId, historyTopic]);

  const liveLoops = loops.filter(isLiveLoop);
  const liveGoal = goal !== null && isLiveGoal(goal.status) ? goal : null;
  if (liveLoops.length === 0 && liveGoal === null) return null;

  const label =
    liveLoops.length > 0 && liveGoal !== null
      ? `${liveLoops.length === 1 ? "Loop" : `${liveLoops.length} loops`} + goal`
      : liveLoops.length > 0
        ? liveLoops.length === 1
          ? liveLoops[0].status === "paused"
            ? "Loop paused"
            : "Loop"
          : `${liveLoops.length} loops`
        : "Goal";

  function markBusy(id: string, value: boolean) {
    setBusy((prev) => {
      const next = { ...prev };
      if (value) next[id] = true;
      else delete next[id];
      return next;
    });
  }

  async function runLoopControl(
    loop: UiLoopRecord,
    kind: "pause" | "resume" | "delete",
  ) {
    const bridge = getActiveBridge(currentSessionId, historyTopic);
    if (!bridge || typeof bridge.controlLoop !== "function") return;
    markBusy(loop.loop_id, true);
    try {
      const result = await bridge.controlLoop(loop.loop_id, kind);
      // Optimistic merge; the `loop/updated` notification confirms it.
      if (kind === "delete") {
        removeLoop(currentSessionId, loop.loop_id, historyTopic);
      } else if (result.loop) {
        upsertLoop(currentSessionId, result.loop, historyTopic);
      }
    } catch {
      // Leave the row as-is so the user can retry.
    } finally {
      markBusy(loop.loop_id, false);
      setArmed(null);
    }
  }

  async function runGoalClear() {
    const bridge = getActiveBridge(currentSessionId, historyTopic);
    if (!bridge || typeof bridge.clearGoal !== "function") return;
    markBusy("goal", true);
    try {
      await bridge.clearGoal();
      setGoal(currentSessionId, null, historyTopic);
    } catch {
      // Retryable.
    } finally {
      markBusy("goal", false);
      setArmed(null);
    }
  }

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        data-testid="session-autonomy-chip"
        data-loop-count={liveLoops.length}
        data-has-goal={liveGoal !== null ? "true" : "false"}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Session autonomy: recurring loops and goal"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-[8px] px-1.5 py-0.5 text-[12px] font-medium text-text-strong hover:bg-surface-container"
      >
        {liveLoops.length > 0 ? <Repeat2 size={13} /> : <Target size={13} />}
        <span className="truncate">{label}</span>
      </button>

      {open && (
        <div
          role="menu"
          data-testid="session-autonomy-menu"
          className="absolute right-0 top-full z-50 mt-1 w-80 rounded-[10px] border border-border bg-surface-container p-1 shadow-lg"
        >
          {liveLoops.map((loop) => {
            const rowBusy = busy[loop.loop_id] === true;
            const deleteArmed = armed === loop.loop_id;
            const nextRun = relativeNextRun(loop.next_run_at_ms);
            return (
              <div
                key={loop.loop_id}
                className="flex items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 hover:bg-surface"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[12px] text-text"
                    title={loop.prompt}
                  >
                    {clip(loop.prompt) || loop.mode || "loop"}
                  </span>
                  <span className="block text-[10px] text-muted">
                    {loop.status}
                    {nextRun ? ` · ${nextRun}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  data-testid={`loop-toggle-${loop.loop_id}`}
                  disabled={rowBusy}
                  onClick={() =>
                    void runLoopControl(
                      loop,
                      loop.status === "paused" ? "resume" : "pause",
                    )
                  }
                  className="shrink-0 rounded-[6px] border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:text-text-strong disabled:opacity-60"
                >
                  {loop.status === "paused" ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  data-testid={`loop-delete-${loop.loop_id}`}
                  disabled={rowBusy}
                  onClick={() => {
                    if (deleteArmed) void runLoopControl(loop, "delete");
                    else setArmed(loop.loop_id);
                  }}
                  className={`shrink-0 rounded-[6px] border px-2 py-0.5 text-[11px] font-medium disabled:opacity-60 ${
                    deleteArmed
                      ? "border-rose-400 text-rose-300"
                      : "border-border text-muted hover:border-rose-400 hover:text-rose-300"
                  }`}
                >
                  {rowBusy
                    ? "Working…"
                    : deleteArmed
                      ? "Confirm delete?"
                      : "Delete"}
                </button>
              </div>
            );
          })}
          {liveGoal !== null && (
            <div
              data-testid="goal-row"
              className="flex items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 hover:bg-surface"
            >
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-[12px] text-text"
                  title={liveGoal.objective}
                >
                  {clip(liveGoal.objective)}
                </span>
                <span className="block text-[10px] text-muted">
                  goal · {liveGoal.status}
                </span>
              </span>
              <button
                type="button"
                data-testid="goal-clear"
                disabled={busy.goal === true}
                onClick={() => {
                  if (armed === "goal") void runGoalClear();
                  else setArmed("goal");
                }}
                className={`shrink-0 rounded-[6px] border px-2 py-0.5 text-[11px] font-medium disabled:opacity-60 ${
                  armed === "goal"
                    ? "border-rose-400 text-rose-300"
                    : "border-border text-muted hover:border-rose-400 hover:text-rose-300"
                }`}
              >
                {busy.goal === true
                  ? "Working…"
                  : armed === "goal"
                    ? "Confirm clear?"
                    : "Clear"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
