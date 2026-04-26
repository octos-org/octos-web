import type { Message } from "../message-store";
import type { CreateMessageId, Now } from "./shared";
import {
  mergeMessageFiles,
  normalizeMessageText,
  withRuntime,
} from "./shared";

export interface CreateAssistantTurnEvent {
  type: "create_assistant_turn";
  message: Omit<Message, "id" | "timestamp"> & { role: "assistant" };
  createId: CreateMessageId;
  now?: Now;
}

export interface AppendAssistantTextEvent {
  type: "append_assistant_text";
  message: Message;
  chunk: string;
  now?: Now;
}

export interface StopStreamingAssistantEvent {
  type: "stop_streaming_assistant";
  message: Message;
  fallbackText?: string;
  now?: Now;
}

export interface EnsureStreamingAssistantEvent {
  type: "ensure_streaming_assistant";
  messages: Message[];
  text?: string;
  createId: CreateMessageId;
  now?: Now;
}

export interface AssistantTurnListProjection {
  messageId: string;
  messages: Message[];
  changed: boolean;
}

export function reduceCreateAssistantTurnEvent(event: CreateAssistantTurnEvent): Message {
  return withRuntime(
    { ...event.message, id: event.createId(), timestamp: (event.now ?? Date.now)() },
    {},
    event.now ?? Date.now,
  );
}

export function reduceAppendAssistantTextEvent(event: AppendAssistantTextEvent): Message {
  return withRuntime(
    { ...event.message, text: event.message.text + event.chunk },
    {},
    event.now ?? Date.now,
  );
}

export function reduceStopStreamingAssistantEvent(event: StopStreamingAssistantEvent): Message {
  if (event.message.status !== "streaming" || event.message.kind === "task_anchor") {
    return event.message;
  }
  return withRuntime(
    {
      ...event.message,
      text: event.message.text.trim()
        ? event.message.text
        : (event.fallbackText ?? "Stopped."),
      status: "stopped",
    },
    { status: "stopped" },
    event.now ?? Date.now,
  );
}

export function reduceEnsureStreamingAssistantEvent(
  event: EnsureStreamingAssistantEvent,
): AssistantTurnListProjection {
  const text = event.text ?? "Resuming ongoing work...";
  const now = event.now ?? Date.now;
  const existing = [...event.messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.status === "streaming");

  if (existing) {
    if (!existing.text && text) {
      const index = event.messages.findIndex((message) => message.id === existing.id);
      if (index !== -1) {
        const messages = [...event.messages];
        messages[index] = withRuntime({ ...existing, text }, {}, now);
        return { messageId: existing.id, messages, changed: true };
      }
    }
    return { messageId: existing.id, messages: event.messages, changed: false };
  }

  const id = event.createId();
  return {
    messageId: id,
    messages: [
      ...event.messages,
      withRuntime({
        id,
        role: "assistant",
        text,
        files: [],
        toolCalls: [],
        status: "streaming",
        timestamp: now(),
      }, {}, now),
    ],
    changed: true,
  };
}

export function mergeAssistantDuplicate(primary: Message, duplicate: Message): Message {
  return {
    ...primary,
    text: primary.text.trim() ? primary.text : duplicate.text,
    files: mergeMessageFiles(duplicate.files, primary.files),
    toolCalls:
      primary.toolCalls.length > 0 ? primary.toolCalls : duplicate.toolCalls,
    sourceToolCallId: primary.sourceToolCallId ?? duplicate.sourceToolCallId,
    historySeq:
      typeof primary.historySeq === "number" && typeof duplicate.historySeq === "number"
        ? Math.max(primary.historySeq, duplicate.historySeq)
        : (duplicate.historySeq ?? primary.historySeq),
  };
}

export function isAssistantCompanionForFileMessage(
  candidate: Message,
  fileMessage: Message,
): boolean {
  if (candidate.kind === "task_anchor" || fileMessage.kind === "task_anchor") {
    return false;
  }
  if (candidate.role !== "assistant" || fileMessage.role !== "assistant") {
    return false;
  }
  if (candidate.files.length > 0 || fileMessage.files.length === 0) {
    return false;
  }
  if (
    normalizeMessageText(candidate.text) !== normalizeMessageText(fileMessage.text)
  ) {
    return false;
  }

  if (
    typeof candidate.historySeq === "number" &&
    typeof fileMessage.historySeq === "number"
  ) {
    return candidate.historySeq + 1 === fileMessage.historySeq;
  }

  return Math.abs(candidate.timestamp - fileMessage.timestamp) <= 5 * 60_000;
}
