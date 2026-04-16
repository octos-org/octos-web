import { useEffect, useState } from "react";

import { useTasks } from "@/store/task-store";

export function SitesTaskStatusIndicator({
  sessionId,
  historyTopic,
  profileId: _profileId,
}: {
  sessionId: string;
  historyTopic?: string;
  profileId?: string;
}) {
  const tasks = useTasks(sessionId, historyTopic);

  if (tasks.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {tasks.map((task) => (
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
  const isActive = task.status === "running" || task.status === "spawned";

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  const elapsed = Math.max(
    0,
    Math.round((Date.now() - new Date(task.started_at).getTime()) / 1000),
  );

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-surface-container px-2.5 py-1 text-[11px]">
      {isActive ? (
        <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
      ) : task.status === "completed" ? (
        <span className="text-green-400 text-xs">&#10003;</span>
      ) : (
        <span className="text-red-400 text-xs">&#10007;</span>
      )}
      <span className="text-muted">{task.tool_name}</span>
      {isActive && <span className="text-muted/70">{elapsed}s</span>}
      {task.status === "failed" && task.error && (
        <span className="max-w-[220px] truncate text-red-400">{task.error}</span>
      )}
    </div>
  );
}
