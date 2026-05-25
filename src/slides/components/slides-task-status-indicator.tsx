import { useEffect, useMemo, useState } from "react";

import { useTasks } from "@/store/task-store";
import {
  displayLabelForRolled,
  rollupTasksByCall,
} from "@/runtime/task-rollup";
import type { BackgroundTaskInfo } from "@/api/types";

function isActiveStatus(status: BackgroundTaskInfo["status"]): boolean {
  return status === "running" || status === "spawned";
}

export function SlidesTaskStatusIndicator({
  sessionId,
  historyTopic,
}: {
  sessionId: string;
  historyTopic?: string;
}) {
  const tasks = useTasks(sessionId, historyTopic);

  // WEB-NEW-18: fold pipeline children under their `run_pipeline`
  // parent so two real pipelines surface as two pills, not 5–9. Non-
  // active tasks (completed / failed) flow through unchanged because
  // the rollup is a no-op for already-terminal rows the user is
  // reviewing post-hoc.
  const visible = useMemo(() => {
    const active = tasks.filter((t) => isActiveStatus(t.status));
    const terminal = tasks.filter((t) => !isActiveStatus(t.status));
    return [...rollupTasksByCall(active), ...terminal];
  }, [tasks]);

  if (visible.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {visible.map((task) => (
        <TaskStatusPill key={task.id} task={task} />
      ))}
    </div>
  );
}

function TaskStatusPill({
  task,
}: {
  task: ReturnType<typeof useTasks>[number];
}) {
  const [, setTick] = useState(0);
  const isActive = isActiveStatus(task.status);

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const elapsed = Math.round(
    (Date.now() - new Date(task.started_at).getTime()) / 1000,
  );

  return (
    <div className="inline-flex items-center gap-1.5 rounded-md bg-surface-container px-2 py-1 text-[11px] font-mono">
      {isActive ? (
        <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
      ) : task.status === "completed" ? (
        <span className="text-green-400 text-xs">&#10003;</span>
      ) : (
        <span className="text-red-400 text-xs">&#10007;</span>
      )}
      <span className="text-muted">{displayLabelForRolled(task)}</span>
      {isActive && <span className="text-muted/60">{elapsed}s</span>}
      {task.status === "failed" && task.error && (
        <span className="max-w-[220px] truncate text-red-400">
          {task.error}
        </span>
      )}
    </div>
  );
}
