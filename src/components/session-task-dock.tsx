import { useMemo } from "react";
import type {
  BackgroundTaskInfo as TaskInfo,
  BackgroundTaskProgressEvent,
  BackgroundTaskRuntimeDetail,
} from "@/api/types";
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

function runtimeDetail(task: TaskInfo): BackgroundTaskRuntimeDetail | undefined {
  return task.runtime_detail ?? undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function taskPhase(task: TaskInfo): string | undefined {
  const detail = runtimeDetail(task);
  return (
    stringField(task.current_phase) ??
    stringField(detail?.current_phase) ??
    stringField(task.lifecycle_state) ??
    stringField(detail?.lifecycle_state)
  );
}

function taskProgressMessage(task: TaskInfo): string | undefined {
  const detail = runtimeDetail(task);
  return (
    stringField(task.progress_message) ??
    stringField(detail?.progress_message) ??
    stringField(detail?.message)
  );
}

function taskProgressEvents(task: TaskInfo): BackgroundTaskProgressEvent[] {
  return task.progress_events ?? [];
}

function formatProgressEvent(event: BackgroundTaskProgressEvent): string {
  const parts: string[] = [];
  if (event.node) parts.push(`node ${event.node}`);
  if (event.tool) parts.push(`tool ${event.tool}`);
  if (typeof event.iteration === "number") parts.push(`iter ${event.iteration}`);
  if (event.phase) parts.push(`phase ${event.phase}`);

  const head = parts.join(" · ");
  const message = stringField(event.message);
  if (head && message) return `${head} — ${message}`;
  return head || message || event.kind;
}

function taskTimeline(task: TaskInfo): string[] {
  return taskProgressEvents(task).slice(-3).map(formatProgressEvent);
}

function taskLatestDetail(task: TaskInfo): string | undefined {
  const lines = taskTimeline(task);
  if (lines.length > 0) {
    return lines[lines.length - 1];
  }
  return taskProgressMessage(task) ?? taskPhase(task);
}

function taskDetail(task: TaskInfo, fallback: string): string {
  const lines = taskTimeline(task);
  if (lines.length > 0) return lines.join("\n");

  const phase = taskPhase(task);
  const message = taskProgressMessage(task);
  if (phase && message) return `${phase}: ${message}`;
  if (message) return message;
  if (phase) return `Current phase: ${phase}`;
  return fallback;
}

function buildSessionSummary(tasks: TaskInfo[]): {
  label: string;
  detail: string;
  active: boolean;
  failed: boolean;
} | null {
  const active = tasks.filter(isTaskActive);
  if (active.length > 1) {
    return {
      label: `${active.length} tasks running`,
      detail: active
        .map((task) => {
          const name = taskDisplayName(task.tool_name);
          const detail = taskLatestDetail(task);
          return detail ? `${name}: ${detail}` : name;
        })
        .join(" · "),
      active: true,
      failed: false,
    };
  }

  if (active.length === 1) {
    const task = active[0];
    return {
      label: `${taskDisplayName(task.tool_name)} running`,
      detail: taskDetail(
        task,
        "Background work continues independently of chat messages.",
      ),
      active: true,
      failed: false,
    };
  }

  const failed = tasks.filter((task) => task.status === "failed");
  if (failed.length > 0) {
    const task = failed[0];
    return {
      label: `${taskDisplayName(task.tool_name)} failed`,
      detail: task.error || taskDetail(task, "Background task needs attention."),
      active: false,
      failed: true,
    };
  }

  return null;
}

export function SessionTaskIndicator() {
  const { currentSessionId, historyTopic } = useSession();
  const currentTasks = useTasks(currentSessionId, historyTopic);

  const summary = useMemo(
    () => {
      return buildSessionSummary(currentTasks);
    },
    [currentTasks],
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
        <div
          className="truncate text-[12px] font-semibold text-text-strong"
          data-testid="session-task-label"
        >
          {summary.label}
        </div>
        <div
          className="whitespace-pre-line text-[10px] leading-4 text-muted"
          data-testid="session-task-detail"
        >
          {summary.detail}
        </div>
      </div>
    </div>
  );
}
