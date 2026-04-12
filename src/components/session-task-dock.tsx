import { useMemo } from "react";
import type { BackgroundTaskInfo as TaskInfo } from "@/api/types";
import { useTasks } from "@/store/task-store";
import { useSession } from "@/runtime/session-context";

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

function buildSummary(tasks: TaskInfo[]): {
  label: string;
  detail: string;
  active: boolean;
  failed: boolean;
} | null {
  const active = tasks.filter(isTaskActive);
  if (active.length > 1) {
    return {
      label: `${active.length} tasks running`,
      detail: active.map((task) => taskDisplayName(task.tool_name)).join(" · "),
      active: true,
      failed: false,
    };
  }

  if (active.length === 1) {
    const task = active[0];
    return {
      label: `${taskDisplayName(task.tool_name)} running`,
      detail: "Background work continues independently of chat messages.",
      active: true,
      failed: false,
    };
  }

  const failed = tasks.filter((task) => task.status === "failed");
  if (failed.length > 0) {
    const task = failed[0];
    return {
      label: `${taskDisplayName(task.tool_name)} failed`,
      detail: task.error || "Background task needs attention.",
      active: false,
      failed: true,
    };
  }

  return null;
}

export function SessionTaskIndicator() {
  const { currentSessionId } = useSession();
  const tasks = useTasks(currentSessionId);

  const summary = useMemo(
    () => buildSummary(tasks),
    [tasks],
  );

  if (!summary) return null;

  return (
    <div
      className="session-task-indicator glass-pill min-w-0 rounded-full px-3 py-2"
      title={summary.detail}
    >
      <span
        className={`session-task-indicator-dot ${
          summary.active
            ? "is-active"
            : summary.failed
              ? "is-failed"
              : ""
        }`}
      />
      <div className="min-w-0">
        <div className="truncate text-[12px] font-semibold text-text-strong">
          {summary.label}
        </div>
        <div className="truncate text-[10px] text-muted">
          {summary.detail}
        </div>
      </div>
    </div>
  );
}
