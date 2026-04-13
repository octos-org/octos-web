import { useEffect, useState } from "react";

import { getSessionTasks } from "@/api/sessions";

interface TaskInfo {
  id: string;
  tool_name: string;
  status: "spawned" | "running" | "completed" | "failed";
  started_at: string;
  error: string | null;
}

export function SlidesTaskStatusIndicator({
  sessionId,
  historyTopic,
}: {
  sessionId: string;
  historyTopic?: string;
}) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (stopped) return;
      try {
        const data = (await getSessionTasks(
          sessionId,
          historyTopic,
        )) as TaskInfo[];
        if (stopped) return;
        setTasks(data);

        if (
          data.some(
            (task) => task.status === "running" || task.status === "spawned",
          )
        ) {
          pollTimer = setTimeout(poll, 2000);
        }
      } catch {
        if (!stopped) pollTimer = setTimeout(poll, 3000);
      }
    }

    function handleBgTasks(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== sessionId) return;
      poll();
    }

    function handleTaskStatus(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId !== sessionId) return;
      poll();
    }

    window.addEventListener("crew:bg_tasks", handleBgTasks);
    window.addEventListener("crew:task_status", handleTaskStatus);
    void poll();

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      window.removeEventListener("crew:bg_tasks", handleBgTasks);
      window.removeEventListener("crew:task_status", handleTaskStatus);
    };
  }, [historyTopic, sessionId]);

  if (tasks.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {tasks.map((task) => (
        <TaskStatusPill key={task.id} task={task} />
      ))}
    </div>
  );
}

function TaskStatusPill({ task }: { task: TaskInfo }) {
  const [, setTick] = useState(0);
  const isActive = task.status === "running" || task.status === "spawned";

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
      <span className="text-muted">{task.tool_name}</span>
      {isActive && <span className="text-muted/60">{elapsed}s</span>}
      {task.status === "failed" && task.error && (
        <span className="max-w-[220px] truncate text-red-400">
          {task.error}
        </span>
      )}
    </div>
  );
}
