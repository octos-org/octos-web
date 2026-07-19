/**
 * Read-only render adapter for the canonical projection model.
 *
 * Presentational chat components still consume the long-lived `Thread` shape.
 * This adapter always supplies that shape from ProjectionStore and never writes
 * to it.
 */

import { useSyncExternalStore } from "react";
import { displayFilenameFromPath } from "@/lib/utils";
import * as ProjectionStore from "@/store/projection-store";
import type {
  AssistantSegmentView,
  BackgroundChildView,
  ThreadView,
  ToolCallView,
} from "@/store/projection";
import type {
  MessageFile,
  Thread,
  ThreadMessage,
  ThreadToolCall,
} from "@/store/thread-store";

interface CachedRenderThreads {
  view: ReturnType<typeof ProjectionStore.getProjection>;
  threads: Thread[];
}

const cache = new Map<string, CachedRenderThreads>();

function timestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFiles(
  files: ReadonlyArray<{ path: string }> | undefined,
): MessageFile[] {
  if (!files) return [];
  const seen = new Set<string>();
  const result: MessageFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    result.push({
      filename: displayFilenameFromPath(file.path),
      path: file.path,
      caption: "",
    });
  }
  return result;
}

function toolStatus(tool: ToolCallView): ThreadToolCall["status"] {
  if (tool.status === null) return "running";
  return tool.status === "complete" || tool.status === "skipped"
    ? "complete"
    : "error";
}

function toToolCall(tool: ToolCallView, seq: number): ThreadToolCall {
  return {
    id: tool.tool_call_id,
    name: tool.name,
    ...(tool.arguments !== undefined
      ? { args: tool.arguments }
      : tool.arguments_preview !== undefined
      ? { args: tool.arguments_preview }
      : {}),
    status: toolStatus(tool),
    progress: tool.progress.map((message, index) => ({
      message,
      ts: seq + index,
    })),
    retryCount: 0,
  };
}

function toolFiles(segment: AssistantSegmentView): MessageFile[] {
  return toFiles([
    ...segment.files,
    ...segment.toolCalls.flatMap((tool) => tool.files),
  ]);
}

function toSegmentMessage(
  segment: AssistantSegmentView,
  threadId: string,
  terminal: ThreadView["terminal"],
): ThreadMessage {
  const terminalFailed = terminal !== null && terminal.outcome !== "completed";
  // A later terminal failure does not retroactively corrupt earlier durable
  // assistant iterations. Preserve those bubbles as complete and represent
  // the turn-level failure explicitly below.
  const status: ThreadMessage["status"] = segment.persisted || terminal?.outcome === "completed"
    ? "complete"
    : terminalFailed
      ? "error"
      : "streaming";
  return {
    id: segment.meta?.message_id ?? segment.assistant_segment_id,
    role: "assistant",
    text: segment.text,
    files: toolFiles(segment),
    toolCalls: segment.toolCalls.map((tool) => toToolCall(tool, segment.seq)),
    status,
    timestamp: timestamp(segment.meta?.persisted_at, segment.seq),
    historySeq: segment.seq,
    intra_thread_seq: segment.seq,
    responseToClientMessageId: threadId,
  };
}

function toBackgroundChildThread(view: ThreadView): Thread {
  const child = view.backgroundChild!;
  return {
    id: child.thread_id,
    turnId: child.turn_id,
    backgroundChild: true,
    parentTurnId: child.parent_turn_id,
    responseToClientMessageId: child.response_to_client_message_id,
    // Existing presentational rows expect a user slot. Chat renderers use
    // `backgroundChild` to omit it, leaving this child stream's assistant
    // completion as its own linked render unit.
    userMsg: {
      id: `background:${child.thread_id}`,
      role: "user",
      text: "",
      files: [],
      toolCalls: [],
      status: "complete",
      timestamp: child.seq,
    },
    responses: [toChildMessage(child, child.thread_id)],
    pendingAssistant: null,
  };
}

function terminalErrorMessage(
  view: ThreadView,
  threadId: string,
): ThreadMessage | null {
  if (!view.terminal || view.terminal.outcome === "completed") return null;
  const label =
    view.terminal.error?.message ??
    (view.terminal.outcome === "interrupted"
      ? "Turn interrupted."
      : "Turn failed.");
  return {
    id: `${view.turn_id}:terminal:${view.terminal.seq}`,
    role: "assistant",
    text: label,
    files: [],
    toolCalls: [],
    status: "error",
    timestamp: view.terminal.seq,
    historySeq: view.terminal.seq,
    intra_thread_seq: view.terminal.seq,
    responseToClientMessageId: threadId,
  };
}

function orphanToolMessage(view: ThreadView, threadId: string): ThreadMessage | null {
  const detachedTools = view.toolCalls.filter(
    (tool) => tool.assistant_segment_id === undefined,
  );
  if (detachedTools.length === 0) return null;
  const seq = Math.min(...detachedTools.map((tool) => tool.files[0]?.seq ?? 0));
  return {
    id: `${view.turn_id}:tools`,
    role: "assistant",
    text: "",
    files: toFiles(detachedTools.flatMap((tool) => tool.files)),
    toolCalls: detachedTools.map((tool) => toToolCall(tool, seq)),
    status: detachedTools.some((tool) => tool.status === null) ? "streaming" : "complete",
    timestamp: seq,
    historySeq: seq,
    intra_thread_seq: seq,
    responseToClientMessageId: threadId,
  };
}

function toChildMessage(child: BackgroundChildView, threadId: string): ThreadMessage {
  return {
    id: child.message_id,
    role: "assistant",
    text: child.content,
    files: toFiles(child.files),
    toolCalls: child.tool_call_id
      ? [
          {
            id: child.tool_call_id,
            name: child.source,
            status: "complete",
            progress: [],
            retryCount: 0,
          },
        ]
      : [],
    status: "complete",
    timestamp: timestamp(child.persisted_at, child.seq),
    historySeq: child.seq,
    intra_thread_seq: child.seq,
    responseToClientMessageId:
      child.response_to_client_message_id ?? threadId,
  };
}

function toThread(view: ThreadView): Thread {
  const id = view.user?.client_message_id ?? view.thread_id;
  const user = view.user;
  const responses = view.assistantSegments
    .map((segment) => toSegmentMessage(segment, id, view.terminal))
    .filter((message) => message.status !== "streaming");
  const pending = view.terminal
    ? null
    : view.assistantSegments
        .map((segment) => toSegmentMessage(segment, id, view.terminal))
        .find((message) => message.status === "streaming") ?? null;
  const detachedTools = orphanToolMessage(view, id);
  if (detachedTools) {
    if (detachedTools.status === "streaming" && !pending) {
      return {
        id,
        turnId: view.turn_id,
        userMsg: {
          id: `user:${view.thread_id}`,
          role: "user",
          text: user?.text ?? "",
          files: toFiles(user?.files),
          toolCalls: [],
          status: "complete",
          timestamp: user?.seq ?? 0,
          historySeq: user?.seq,
          intra_thread_seq: user?.seq,
          ...(user?.client_message_id
            ? { clientMessageId: user.client_message_id }
            : {}),
        },
        responses,
        pendingAssistant: detachedTools,
        ...(user ? {} : { placeholderOrigin: true }),
      };
    }
    responses.push(detachedTools);
  }
  const terminalError = terminalErrorMessage(view, id);
  // Preserve a terminal failure even when assistant content preceded it.
  // Otherwise an errored/interrupted turn looks like an ordinary completion.
  if (terminalError) responses.push(terminalError);
  return {
    id,
    turnId: view.turn_id,
    userMsg: {
      id: `user:${view.thread_id}`,
      role: "user",
      text: user?.text ?? "",
      files: toFiles(user?.files),
      toolCalls: [],
      status: "complete",
      timestamp: user?.seq ?? 0,
      historySeq: user?.seq,
      intra_thread_seq: user?.seq,
      ...(user?.client_message_id
        ? { clientMessageId: user.client_message_id }
        : {}),
    },
    responses,
    pendingAssistant: pending,
    ...(user ? {} : { placeholderOrigin: true }),
  };
}

/** Convert a pure projection snapshot. Exported for unit-level adapter tests. */
export function projectionToRenderThreads(
  view: ReturnType<typeof ProjectionStore.getProjection>,
): Thread[] {
  return view.threads.map((thread) =>
    thread.backgroundChild ? toBackgroundChildThread(thread) : toThread(thread),
  );
}

/** Select the canonical render source. */
export function getRenderThreads(sessionId: string, topic?: string): Thread[] {
  const key = ProjectionStore.projectionStoreKey(sessionId, topic);
  const view = ProjectionStore.getProjection(key);
  const cached = cache.get(key);
  if (cached?.view === view) return cached.threads;
  const threads = projectionToRenderThreads(view);
  cache.set(key, { view, threads });
  return threads;
}

/** React selector used by every chat render surface. */
export function useRenderThreads(sessionId: string, topic?: string): Thread[] {
  return useSyncExternalStore(
    ProjectionStore.subscribe,
    () => getRenderThreads(sessionId, topic),
    () => getRenderThreads(sessionId, topic),
  );
}

export function __resetProjectionRenderAdapterForTests(): void {
  cache.clear();
}
