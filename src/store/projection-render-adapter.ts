/**
 * Read-only render adapter for the canonical projection model.
 *
 * Presentational chat components still consume the long-lived `Thread` shape.
 * This adapter supplies that shape from ProjectionStore when v2 was negotiated
 * and delegates to ThreadStore only for an old-server session. It never writes
 * either store.
 */

import { useSyncExternalStore } from "react";
import { displayFilenameFromPath } from "@/lib/utils";
import * as ProjectionStore from "@/store/projection-store";
import * as ThreadStore from "@/store/thread-store";
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
const EMPTY_LEGACY_THREADS: Thread[] = [];

function legacyThreads(sessionId: string, topic?: string): Thread[] {
  const legacy = ThreadStore as typeof ThreadStore;
  // Vitest's module mock proxy throws when an absent named export is read;
  // check ownership before touching it so isolated legacy-render mocks can
  // continue providing only useThreads.
  if (
    Object.prototype.hasOwnProperty.call(legacy, "getThreads") &&
    typeof legacy.getThreads === "function"
  ) {
    return legacy.getThreads(sessionId, topic);
  }
  // Production ThreadStore always exports getThreads. Returning a stable
  // empty snapshot for narrow isolated mocks keeps useSyncExternalStore's
  // contract intact without invoking another hook from this selector.
  return EMPTY_LEGACY_THREADS;
}

function subscribeLegacy(listener: () => void): () => void {
  const legacy = ThreadStore as typeof ThreadStore & {
    subscribe?: (callback: () => void) => () => void;
  };
  return Object.prototype.hasOwnProperty.call(legacy, "subscribe") &&
    typeof legacy.subscribe === "function"
    ? legacy.subscribe(listener)
    : () => {};
}

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

/** Select the active render source without ever combining the two models. */
export function getRenderThreads(sessionId: string, topic?: string): Thread[] {
  const mode = ProjectionStore.projectionMode(sessionId, topic);
  // Do not briefly render a legacy REST/history result before the server has
  // selected its capability path. The old-server fallback becomes visible as
  // soon as its session/open ack chooses `legacy`.
  if (mode === "pending") return EMPTY_LEGACY_THREADS;
  if (mode === "legacy") {
    return legacyThreads(sessionId, topic);
  }
  const key = ProjectionStore.projectionStoreKey(sessionId, topic);
  const view = ProjectionStore.getProjection(key);
  const cached = cache.get(key);
  if (cached?.view === view) return cached.threads;
  const threads = projectionToRenderThreads(view);
  cache.set(key, { view, threads });
  return threads;
}

/** React selector used by every chat render surface. Both stores notify so a
 * capability transition switches cleanly, but only one store is read. */
export function useRenderThreads(sessionId: string, topic?: string): Thread[] {
  return useSyncExternalStore(
    (listener) => {
      const offProjection = ProjectionStore.subscribe(listener);
      const offLegacy = subscribeLegacy(listener);
      return () => {
        offProjection();
        offLegacy();
      };
    },
    () => getRenderThreads(sessionId, topic),
    () => getRenderThreads(sessionId, topic),
  );
}

/** Reactive capability selector for history/clear surfaces that must avoid
 * touching legacy content once a v2 session has been confirmed. */
export function useProjectionV2(sessionId: string, topic?: string): boolean {
  return useSyncExternalStore(
    ProjectionStore.subscribe,
    () => ProjectionStore.isProjectionV2Enabled(sessionId, topic),
    () => ProjectionStore.isProjectionV2Enabled(sessionId, topic),
  );
}

/** Reactive negotiated mode for history loaders. `pending` must not load or
 * surface legacy content, otherwise a new server can render both paths during
 * its handshake. */
export function useProjectionMode(
  sessionId: string,
  topic?: string,
): ProjectionStore.ProjectionMode {
  return useSyncExternalStore(
    ProjectionStore.subscribe,
    () => ProjectionStore.projectionMode(sessionId, topic),
    () => ProjectionStore.projectionMode(sessionId, topic),
  );
}

export function __resetProjectionRenderAdapterForTests(): void {
  cache.clear();
}
