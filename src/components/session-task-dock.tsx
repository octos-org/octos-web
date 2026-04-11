import { useEffect, useMemo, useState } from "react";
import type { BackgroundTaskInfo as TaskInfo } from "@/api/types";
import { useTasks } from "@/store/task-store";
import { useSession } from "@/runtime/session-context";

function isTaskActive(task: TaskInfo): boolean {
  return task.status === "spawned" || task.status === "running";
}

function taskDisplayName(toolName: string): string {
  switch (toolName) {
    case "podcast_generate":
      return "Podcast generation";
    case "fm_tts":
      return "Voice generation";
    case "voice_transcribe":
      return "Transcription";
    default:
      return toolName.replace(/_/gu, " ");
  }
}

function taskStatusLabel(task: TaskInfo): string {
  switch (task.status) {
    case "spawned":
      return "Queued";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return task.status;
  }
}

function summarizeTasks(activeTasks: TaskInfo[]) {
  const primary = activeTasks[0];

  if (activeTasks.length === 1 && primary) {
    return {
      eyebrow: "Background task",
      title: `${taskDisplayName(primary.tool_name)} is running`,
      body: "You can keep chatting. The result will appear in this session automatically when the task finishes.",
    };
  }

  if (activeTasks.length > 1) {
    return {
      eyebrow: "Background tasks",
      title: `${activeTasks.length} tasks are running`,
      body: "You can keep chatting while these tasks continue in the background.",
    };
  }

  if (activeTasks.length === 0 && primary) {
    return {
      eyebrow: "Background task",
      title: `${taskDisplayName(primary.tool_name)} failed`,
      body: "The task stopped before finishing. You can inspect the error below and retry if needed.",
    };
  }

  return {
    eyebrow: "Background task",
    title: "Background task failed",
    body: "The task stopped before finishing. You can inspect the error below and retry if needed.",
  };
}

function TaskStatusRow({ task }: { task: TaskInfo }) {
  const [, setTick] = useState(0);
  const active = isTaskActive(task);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  const elapsed = Math.round(
    (Date.now() - new Date(task.started_at).getTime()) / 1000,
  );

  return (
    <div className="task-status-row flex items-start gap-3 rounded-[10px] px-3 py-2">
      <div
        className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${
          active
            ? "bg-accent animate-pulse"
            : task.status === "completed"
              ? "bg-green-400"
              : "bg-red-400"
        }`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12px] font-semibold text-text-strong">
            {taskDisplayName(task.tool_name)}
          </span>
          <span className="text-[11px] text-muted">{taskStatusLabel(task)}</span>
          {active && (
            <span className="ml-auto shrink-0 font-mono text-[11px] text-muted/70">
              {elapsed}s
            </span>
          )}
        </div>
        {task.error && (
          <div className="mt-1 truncate text-[11px] text-red-400">
            {task.error}
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionTaskDock() {
  const { currentSessionId, activeTaskOnServer } = useSession();
  const tasks = useTasks(currentSessionId);

  const visibleTasks = useMemo(() => {
    const active = tasks.filter(isTaskActive);
    if (active.length > 0) return active;
    return tasks.filter((task) => task.status === "failed").slice(0, 2);
  }, [tasks]);

  const summary = useMemo(() => summarizeTasks(visibleTasks), [visibleTasks]);
  const activeTaskCount = visibleTasks.filter(isTaskActive).length;
  const shouldShowGenericActiveCard = visibleTasks.length === 0 && activeTaskOnServer;

  if (visibleTasks.length === 0 && !shouldShowGenericActiveCard) return null;

  return (
    <div className="px-3 pt-2">
      <div className="task-status-card glass-section animate-shell-rise rounded-[12px] p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="shell-kicker text-accent/80">
              {shouldShowGenericActiveCard ? "Background task" : summary.eyebrow}
            </div>
            <div className="mt-1 text-sm font-semibold text-text-strong">
              {shouldShowGenericActiveCard
                ? "Background task is running"
                : summary.title}
            </div>
            <div className="mt-1 text-xs leading-relaxed text-muted">
              {shouldShowGenericActiveCard
                ? "You can keep chatting. Results will appear in this session automatically when the task finishes."
                : summary.body}
            </div>
          </div>
          <div className="task-status-count rounded-full px-2.5 py-1 text-[11px] font-medium">
            {shouldShowGenericActiveCard
              ? "1 active"
              : activeTaskCount > 0
                ? `${activeTaskCount} active`
                : "needs attention"}
          </div>
        </div>

        {(shouldShowGenericActiveCard || visibleTasks.some(isTaskActive)) && (
          <div className="task-status-progress mt-3">
            <span className="task-status-progress-bar" />
          </div>
        )}

        {visibleTasks.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {visibleTasks.map((task) => (
              <TaskStatusRow key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
