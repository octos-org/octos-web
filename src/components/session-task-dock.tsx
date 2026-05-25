import { useMemo, type ReactElement } from "react";
import type { BackgroundTaskInfo as TaskInfo } from "@/api/types";
import { useTasks } from "@/store/task-store";
import { useSession } from "@/runtime/session-context";
import {
  displayLabelForRolled,
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

  const summary = useMemo(() => buildSummary(currentTasks), [currentTasks]);

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

  return (
    <div
      data-testid="session-task-indicator"
      data-task-count={count}
      data-task-state={summary.state}
      className="session-task-indicator inline-flex items-center gap-2"
      title={summary.detail}
    >
      <span
        className="inline-flex items-center gap-1"
        aria-hidden="true"
      >
        {dots}
      </span>
      <span className="truncate text-[12px] font-medium text-text-strong">
        {summary.label}
      </span>
    </div>
  );
}
