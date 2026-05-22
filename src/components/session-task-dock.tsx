import { useMemo } from "react";
import type { BackgroundTaskInfo as TaskInfo } from "@/api/types";
import { useTasks } from "@/store/task-store";
import { useSession } from "@/runtime/session-context";

// The tasks dock reads from `useTasks()`, which is fed by
// `runtime/task-watcher.ts` polling through the `getSessionTasks`
// wrapper (WS `session/tasks.list`). Live task transitions also
// arrive via the WS bridge's `task/updated` notifications. The legacy
// REST fallback was retired in M12 Phase D-5. This component never
// hits an HTTP endpoint directly.

function isTaskActive(task: TaskInfo): boolean {
  return task.status === "spawned" || task.status === "running";
}

function taskDisplayName(toolName: string): string {
  switch (toolName) {
    case "podcast_generate":
      return "Podcast";
    case "fm_tts":
      return "Voice";
    case "voice_transcribe":
      return "Transcript";
    default:
      return toolName.replace(/_/gu, " ");
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
  const active = tasks.filter(isTaskActive);
  if (active.length === 1) {
    return {
      active,
      failed: null,
      label: `${taskDisplayName(active[0].tool_name)} running`,
      detail: "Background work continues independently of chat messages.",
      state: "active",
    };
  }
  if (active.length > 1) {
    return {
      active,
      failed: null,
      label: `${active.length} tasks running`,
      detail: active.map((task) => taskDisplayName(task.tool_name)).join(" · "),
      state: "active",
    };
  }
  const failed = tasks.find((task) => task.status === "failed") ?? null;
  if (failed !== null) {
    return {
      active: [],
      failed,
      label: `${taskDisplayName(failed.tool_name)} failed`,
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
  const dots =
    summary.state === "failed"
      ? [
          <span
            key="failed-dot"
            className="task-constellation-dot block h-1.5 w-1.5 rounded-full bg-red-400"
            style={{ animationDelay: "0ms" }}
          />,
        ]
      : summary.active.map((task, i) => (
          <span
            key={task.id}
            className={`task-constellation-dot block h-1.5 w-1.5 rounded-full ${DOT_PALETTE[i % DOT_PALETTE.length]}`}
            style={{ animationDelay: `${i * 200}ms` }}
          />
        ));

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
