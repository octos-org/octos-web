import { useEffect, useState } from "react";

import { buildApiHeaders } from "@/api/client";
import { API_BASE } from "@/lib/constants";

interface TaskInfo {
  id: string;
  tool_name: string;
  status: "spawned" | "running" | "completed" | "failed";
  started_at: string;
  error: string | null;
}

export function SitesTaskStatusIndicator({
  sessionId,
  profileId,
}: {
  sessionId: string;
  profileId?: string;
}) {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (stopped) return;
      try {
        const response = await fetch(
          `${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/tasks`,
          { headers: buildApiHeaders({}, profileId) },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as TaskInfo[];
        if (stopped) return;
        setTasks(data);

        if (data.some((task) => task.status === "running" || task.status === "spawned")) {
          pollTimer = setTimeout(poll, 2000);
        }
      } catch {
        if (!stopped) pollTimer = setTimeout(poll, 3000);
      }
    }

    function handleEvent(event: Event) {
      const detail =
        event instanceof CustomEvent ? (event.detail as unknown) : undefined;
      if (
        !detail ||
        typeof detail !== "object" ||
        !("sessionId" in detail) ||
        detail.sessionId !== sessionId
      ) {
        return;
      }
      void poll();
    }

    void poll();
    window.addEventListener("crew:bg_tasks", handleEvent);
    window.addEventListener("crew:task_status", handleEvent);

    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      window.removeEventListener("crew:bg_tasks", handleEvent);
      window.removeEventListener("crew:task_status", handleEvent);
    };
  }, [profileId, sessionId]);

  if (tasks.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
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
