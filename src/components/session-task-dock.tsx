import { useEffect, useMemo, useState, type ReactElement } from "react";
import type { BackgroundTaskInfo as TaskInfo } from "@/api/types";
import { mergeTask, useTasks } from "@/store/task-store";
import { useSession } from "@/runtime/session-context";
import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import {
  displayLabelForRolled,
  expandRolledGroup,
  rollupTasksByCall,
} from "@/runtime/task-rollup";

// The tasks dock reads from `useTasks()`, which is fed by
// `runtime/task-watcher.ts` polling through the `getSessionTasks`
// wrapper (WS `session/tasks.list`). Live task transitions also
// arrive via the WS bridge's `task/updated` notifications. The legacy
// REST fallback was retired in M12 Phase D-5. This component never
// hits an HTTP endpoint directly.

function isTaskActive(task: TaskInfo): boolean {
  return task.status === "spawned" || task.status === "running";
}

function taskDisplayName(task: TaskInfo): string {
  switch (task.tool_name) {
    case "podcast_generate":
      return "Podcast";
    case "fm_tts":
      return "Voice";
    case "voice_transcribe":
      return "Transcript";
    default:
      // Pipeline-aware: orphan children (parent absent) become
      // `Analyze` / `Synthesize` instead of `pipeline:analyze`.
      return displayLabelForRolled(task);
  }
}

interface IndicatorSummary {
  active: TaskInfo[];
  failed: TaskInfo | null;
  label: string;
  detail: string;
  state: "active" | "failed";
}

function buildSummary(tasks: TaskInfo[]): IndicatorSummary | null {
  // WEB-NEW-18: roll pipeline children up under the parent
  // `run_pipeline` task by `tool_call_id` so the dock counter reflects
  // the real number of user-visible jobs rather than the raw
  // parent+children fanout. See `runtime/task-rollup.ts`.
  const active = rollupTasksByCall(tasks.filter(isTaskActive));
  if (active.length === 1) {
    return {
      active,
      failed: null,
      label: `${taskDisplayName(active[0])} running`,
      detail: "Background work continues independently of chat messages.",
      state: "active",
    };
  }
  if (active.length > 1) {
    return {
      active,
      failed: null,
      label: `${active.length} tasks running`,
      detail: active.map((task) => taskDisplayName(task)).join(" · "),
      state: "active",
    };
  }
  const failed = tasks.find((task) => task.status === "failed") ?? null;
  if (failed !== null) {
    return {
      active: [],
      failed,
      label: `${taskDisplayName(failed)} failed`,
      detail: failed.error || "Background task needs attention.",
      state: "failed",
    };
  }
  return null;
}

// Small palette cycled by index. Falls back to plain accent if the
// theme doesn't define the secondary/tertiary slots — Tailwind ignores
// unknown utilities at runtime, but to be safe we use opacity steps
// on `bg-accent` which always resolve.
const DOT_PALETTE = ["bg-accent", "bg-accent/70", "bg-accent/40"] as const;

export function SessionTaskIndicator() {
  const { currentSessionId, historyTopic } = useSession();
  const currentTasks = useTasks(currentSessionId, historyTopic);
  const [open, setOpen] = useState(false);
  // Task ids with an in-flight cancel request, so the row shows "Cancelling…"
  // until the authoritative `task/updated` flips it to a terminal state.
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});

  // The indicator stays mounted across session/topic switches, so a menu left
  // open in one session must not render already-open (and destructive) over a
  // different cached session's tasks (codex review).
  useEffect(() => {
    setOpen(false);
    setCancelling({});
  }, [currentSessionId, historyTopic]);

  const summary = useMemo(() => buildSummary(currentTasks), [currentTasks]);

  // A menu row is a rolled-up representative (a `run_pipeline` parent can
  // stand in for several `pipeline:*` children sharing its tool_call_id).
  // Cancel EVERY active raw task in the representative's group, not just the
  // representative — otherwise a sibling immediately becomes the next
  // representative and one Cancel doesn't clear the row (codex review).
  // `expandRolledGroup` mirrors the rollup's collapse rule: ONLY pipeline
  // families expand; unrelated tasks sharing a `tool_call_id` render as
  // separate rows, so their Cancel must stay per-row (codex round 2).
  async function cancelGroup(representative: TaskInfo) {
    const members = expandRolledGroup(representative, currentTasks).filter(
      isTaskActive,
    );
    const ids = members.length > 0 ? members : [representative];
    setCancelling((prev) => {
      const next = { ...prev };
      for (const m of ids) next[m.id] = true;
      return next;
    });
    const bridge = getActiveBridge(currentSessionId, historyTopic);
    await Promise.all(
      ids.map(async (task) => {
        try {
          if (!bridge) throw new Error("bridge not connected");
          const result = await bridge.cancelTask(task.id);
          // Optimistically reflect the authoritative post-cancel state; the
          // server's `task/updated` confirms it moments later. The web status
          // union has no `cancelled`, so cancelled/pending → terminal
          // `completed` (drops from active, no red flash); an already-finished
          // task comes back completed/failed; a still-`running` result means
          // the cancel didn't take, so keep it active.
          const status: TaskInfo["status"] =
            result.status === "cancelled" || result.status === "pending"
              ? "completed"
              : result.status === "running"
                ? "running"
                : result.status === "failed"
                  ? "failed"
                  : "completed";
          mergeTask(currentSessionId, { ...task, status }, historyTopic);
        } catch {
          // Leave the task as-is so the user can retry.
        } finally {
          setCancelling((prev) => {
            const next = { ...prev };
            delete next[task.id];
            return next;
          });
        }
      }),
    );
  }

  if (!summary) return null;

  // Header constellation (M9 follow-up, 2026-05-22). Inline dot-per-task
  // visualisation that scales with count, replacing the "glass-pill"
  // rectangle. The pill chrome is gone — just dots + a small label.
  //
  // codex PR #147 review (MINOR 2, 2026-05-22): cap the rendered dots
  // at MAX_VISIBLE_DOTS so 20+ active tasks don't blow past the header
  // `42vw` max-width. When the real count exceeds the cap we render
  // the first (MAX_VISIBLE_DOTS - 1) dots followed by a "+N" overflow
  // indicator. `data-task-count` still reflects the REAL count so
  // existing tests asserting numerics continue to pass.
  const MAX_VISIBLE_DOTS = 8;
  const dots: ReactElement[] = [];
  if (summary.state === "failed") {
    dots.push(
      <span
        key="failed-dot"
        className="task-constellation-dot block h-1.5 w-1.5 rounded-full bg-red-400"
        style={{ animationDelay: "0ms" }}
      />,
    );
  } else {
    const total = summary.active.length;
    if (total <= MAX_VISIBLE_DOTS) {
      for (let i = 0; i < total; i += 1) {
        const task = summary.active[i];
        dots.push(
          <span
            key={task.id}
            className={`task-constellation-dot block h-1.5 w-1.5 rounded-full ${DOT_PALETTE[i % DOT_PALETTE.length]}`}
            style={{ animationDelay: `${i * 200}ms` }}
          />,
        );
      }
    } else {
      // Render the first (MAX_VISIBLE_DOTS - 1) dots, then a "+N"
      // overflow chip in place of dot #MAX_VISIBLE_DOTS.
      const visible = MAX_VISIBLE_DOTS - 1;
      for (let i = 0; i < visible; i += 1) {
        const task = summary.active[i];
        dots.push(
          <span
            key={task.id}
            className={`task-constellation-dot block h-1.5 w-1.5 rounded-full ${DOT_PALETTE[i % DOT_PALETTE.length]}`}
            style={{ animationDelay: `${i * 200}ms` }}
          />,
        );
      }
      const overflow = total - visible;
      dots.push(
        <span
          key="task-constellation-overflow"
          data-testid="task-constellation-overflow"
          className="task-constellation-overflow ml-0.5 inline-flex items-center text-[10px] font-medium text-text-strong"
        >
          {`+${overflow}`}
        </span>,
      );
    }
  }

  const count = summary.state === "failed" ? 1 : summary.active.length;
  // Only running/spawned tasks are cancellable; a failed-only summary has none.
  const cancellable = summary.active;

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        data-testid="session-task-indicator"
        data-task-count={count}
        data-task-state={summary.state}
        className="session-task-indicator inline-flex items-center gap-2 rounded-[8px] px-1 py-0.5 hover:bg-surface-container disabled:cursor-default"
        title={summary.detail}
        aria-haspopup={cancellable.length > 0 ? "menu" : undefined}
        aria-expanded={cancellable.length > 0 ? open : undefined}
        disabled={cancellable.length === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="inline-flex items-center gap-1" aria-hidden="true">
          {dots}
        </span>
        <span className="truncate text-[12px] font-medium text-text-strong">
          {summary.label}
        </span>
      </button>

      {open && cancellable.length > 0 && (
        <div
          role="menu"
          data-testid="session-task-cancel-menu"
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-[10px] border border-border bg-surface-container p-1 shadow-lg"
        >
          {cancellable.map((task) => {
            const busy = cancelling[task.id] === true;
            return (
              <div
                key={task.id}
                className="flex items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 hover:bg-surface"
              >
                <span className="truncate text-[12px] text-text">
                  {taskDisplayName(task)}
                </span>
                <button
                  type="button"
                  data-testid={`cancel-task-${task.id}`}
                  className="shrink-0 rounded-[6px] border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:border-rose-400 hover:text-rose-300 disabled:opacity-60"
                  disabled={busy}
                  onClick={() => void cancelGroup(task)}
                >
                  {busy ? "Cancelling…" : "Cancel"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
