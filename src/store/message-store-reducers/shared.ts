import type {
  Message,
  MessageRuntime,
  MessageRuntimeStatus,
  MessageRuntimeType,
  MessageFile,
} from "../message-store";
import { displayFilenameFromPath } from "../../lib/utils";

export type CreateMessageId = () => string;
export type Now = () => number;

/** Task completion notifications are status messages, not real responses. */
export const TASK_COMPLETION_RE = /^[✓✗]\s+\S+\s+(completed|failed)\s*\(/u;

export function compareMessagesForDisplay(a: Message, b: Message): number {
  const aIsTaskAnchor = a.kind === "task_anchor";
  const bIsTaskAnchor = b.kind === "task_anchor";
  if (aIsTaskAnchor || bIsTaskAnchor) {
    const byTime = a.timestamp - b.timestamp;
    if (byTime !== 0) return byTime;
  }

  const aSeq =
    typeof a.historySeq === "number" ? a.historySeq : Number.MAX_SAFE_INTEGER;
  const bSeq =
    typeof b.historySeq === "number" ? b.historySeq : Number.MAX_SAFE_INTEGER;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return a.timestamp - b.timestamp;
}

export function sortedMessagesForDisplay(messages: Message[]): Message[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => compareMessagesForDisplay(a.message, b.message) || a.index - b.index)
    .map(({ message }) => message);
}

export function realignTaskAnchors(messages: Message[]): Message[] {
  return messages.map((message) => {
    const startedAt = message.taskAnchor?.taskStartedAt
      ? new Date(message.taskAnchor.taskStartedAt).getTime()
      : NaN;
    if (message.kind !== "task_anchor" || !Number.isFinite(startedAt)) {
      return message;
    }
    const timestamp = startedAt;
    return timestamp === message.timestamp ? message : { ...message, timestamp };
  });
}

export function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => !!value && !!value.trim())
        .map((value) => value.trim()),
    ),
  ];
}

export function messageRuntimeType(message: Pick<Message, "role" | "kind">): MessageRuntimeType {
  if (message.kind === "task_anchor") return "background_task";
  return message.role;
}

export function runtimeStatusForMessageStatus(status: Message["status"]): MessageRuntimeStatus {
  switch (status) {
    case "streaming":
      return "ongoing";
    case "complete":
      return "completed";
    case "stopped":
      return "stopped";
    case "error":
      return "failed";
  }
}

export function runtimeForMessage(
  message: Message,
  overrides: Partial<MessageRuntime> = {},
  now: Now = Date.now,
): MessageRuntime {
  return {
    ...(message.runtime ?? {
      type: messageRuntimeType(message),
      status: runtimeStatusForMessageStatus(message.status),
      updatedAt: now(),
    }),
    type: overrides.type ?? messageRuntimeType(message),
    status: overrides.status ?? runtimeStatusForMessageStatus(message.status),
    updatedAt: overrides.updatedAt ?? now(),
    taskId: overrides.taskId ?? message.taskAnchor?.taskId ?? message.runtime?.taskId,
    toolCallId:
      overrides.toolCallId ??
      message.sourceToolCallId ??
      message.taskAnchor?.toolCallId ??
      message.runtime?.toolCallId,
    phase: overrides.phase ?? message.taskAnchor?.currentPhase ?? message.runtime?.phase,
    detail:
      overrides.detail ??
      message.taskAnchor?.progressMessage ??
      message.taskAnchor?.error ??
      message.runtime?.detail,
  };
}

export function withRuntime<T extends Message>(
  message: T,
  overrides: Partial<MessageRuntime> = {},
  now: Now = Date.now,
): T {
  return {
    ...message,
    runtime: runtimeForMessage(message, overrides, now),
  };
}

export function pathMatchKeys(path: string): string[] {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    const normalized = value?.trim();
    if (normalized) keys.add(normalized);
  };

  add(path);
  try {
    add(decodeURIComponent(path));
  } catch {
    // Keep the original path when decoding fails.
  }
  add(displayFilenameFromPath(path));
  return [...keys];
}

export function findMessageIndexById(list: Message[], messageId: string): number {
  return list.findIndex((message) => message.id === messageId);
}

export function messageBelongsToDifferentTask(message: Message, taskId?: string): boolean {
  return Boolean(
    taskId &&
      message.kind === "task_anchor" &&
      message.taskAnchor?.taskId &&
      message.taskAnchor.taskId !== taskId,
  );
}

export function findMessageIndexByToolCallId(
  list: Message[],
  toolCallId?: string,
  taskId?: string,
): number {
  if (!toolCallId) return -1;
  return list.findIndex(
    (message) =>
      !messageBelongsToDifferentTask(message, taskId) &&
      (message.toolCalls.some((toolCall) => toolCall.id === toolCallId) ||
        message.sourceToolCallId === toolCallId),
  );
}

export function mergeMessageFiles(primary: MessageFile[], fallback: MessageFile[]): MessageFile[] {
  const merged = new Map<string, MessageFile>();

  for (const file of primary) {
    merged.set(file.path, file);
  }

  for (const file of fallback) {
    const existing = merged.get(file.path);
    if (!existing) {
      merged.set(file.path, file);
      continue;
    }

    merged.set(file.path, {
      ...existing,
      filename: existing.filename || file.filename,
      caption: existing.caption || file.caption || "",
    });
  }

  return Array.from(merged.values());
}

export function normalizeMessageText(text: string): string {
  // Strip tool progress lines, streaming stats, and provider info that
  // may differ between the SSE-streamed text and the API-stored text.
  const lines = text.split("\n").filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^[✓✗⚙📄✦]\s*[`[]/u.test(t)) return false; // tool badges
    if (/^via\s+\S+\s+\(/u.test(t)) return false; // provider info
    if (/^\d+s(\s*·\s*[\d.]+k?[↑↓].*)?$/u.test(t)) return false; // streaming stats
    if (t === "Processing") return false;
    return true;
  });
  return lines.join(" ").replace(/\s+/gu, " ").trim();
}
