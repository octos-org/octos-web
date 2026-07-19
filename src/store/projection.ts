/**
 * Pure canonical projection for `projection.envelope.v2`.
 *
 * The store owns admission, gap recovery, snapshots, and cursor watermarks;
 * this module only turns already-admitted v2 envelopes into immutable render
 * state. Keeping it pure makes segment and attachment ownership behavior
 * independently testable.
 */

import type {
  ProjectionEnvelopeV2,
  ProjectionEnvelopeV2Cursor,
  ProjectionEnvelopeV2FileRef,
  ProjectionEnvelopeV2MessageMeta,
  ProjectionEnvelopeV2TerminalError,
  ProjectionEnvelopeV2TerminalOutcome,
  ProjectionEnvelopeV2TokenUsage,
  ProjectionEnvelopeV2ToolEndStatus,
} from "../runtime/projection-envelope-v2";

export interface UserView {
  seq: number;
  client_message_id?: string;
  text: string;
  files: ReadonlyArray<ProjectionFileView>;
}

export interface ProjectionFileView extends ProjectionEnvelopeV2FileRef {
  seq: number;
}

export interface ToolCallView {
  tool_call_id: string;
  name: string;
  arguments?: unknown;
  arguments_preview?: string;
  progress: ReadonlyArray<string>;
  status: ProjectionEnvelopeV2ToolEndStatus | null;
  error: string | null;
  reason?: string;
  output_preview?: string;
  duration_ms?: number;
  /** Segment selected at tool-open time, never inferred from a later bubble. */
  assistant_segment_id?: string;
  files: ReadonlyArray<ProjectionFileView>;
}

export interface AssistantSegmentView {
  assistant_segment_id: string;
  seq: number;
  text: string;
  meta: ProjectionEnvelopeV2MessageMeta | null;
  persisted: boolean;
  files: ReadonlyArray<ProjectionFileView>;
  toolCalls: ReadonlyArray<ToolCallView>;
}

export interface TurnTerminalView {
  outcome: ProjectionEnvelopeV2TerminalOutcome;
  error: ProjectionEnvelopeV2TerminalError | null;
  tokenUsage: ProjectionEnvelopeV2TokenUsage | null;
  seq: number;
}

export interface BackgroundChildView {
  thread_id: string;
  turn_id: string;
  seq: number;
  parent_turn_id: string;
  response_to_client_message_id: string;
  task_id: string;
  tool_call_id?: string;
  message_id: string;
  source: string;
  persisted_at: string;
  content: string;
  files: ReadonlyArray<ProjectionFileView>;
}

export interface ThreadView {
  thread_id: string;
  turn_id: string;
  user: UserView | null;
  assistantSegments: ReadonlyArray<AssistantSegmentView>;
  toolCalls: ReadonlyArray<ToolCallView>;
  terminal: TurnTerminalView | null;
  /** Present only for the independent child stream itself. */
  backgroundChild: BackgroundChildView | null;
  cursor: ProjectionEnvelopeV2Cursor | null;
}

export interface ChatViewModel {
  /** Includes parent and child streams. Consumers link `backgroundChild` via
   * `parent_turn_id`; a child never mutates the parent's terminal stream. */
  threads: ReadonlyArray<ThreadView>;
}

export interface ProjectionMetrics {
  duplicates: number;
  droppedAfterTerminal: number;
  /** Input observations that were not presented in per-thread seq order. */
  outOfOrder: number;
}

export interface ProjectionResult {
  view: ChatViewModel;
  metrics: ProjectionMetrics;
}

type MutableFile = ProjectionFileView;

interface MutableTool {
  tool_call_id: string;
  name: string;
  arguments?: unknown;
  arguments_preview?: string;
  progress: string[];
  status: ProjectionEnvelopeV2ToolEndStatus | null;
  error: string | null;
  reason?: string;
  output_preview?: string;
  duration_ms?: number;
  assistant_segment_id?: string;
  files: MutableFile[];
}

interface MutableSegment {
  assistant_segment_id: string;
  seq: number;
  text: string;
  meta: ProjectionEnvelopeV2MessageMeta | null;
  persisted: boolean;
  files: MutableFile[];
  toolCallIds: string[];
}

interface MutableThread {
  thread_id: string;
  turn_id: string;
  user: UserView | null;
  segments: Map<string, MutableSegment>;
  segmentOrder: string[];
  activeSegmentId: string | null;
  tools: Map<string, MutableTool>;
  toolOrder: string[];
  terminal: TurnTerminalView | null;
  backgroundChild: BackgroundChildView | null;
  cursor: ProjectionEnvelopeV2Cursor | null;
}

/** Retained for tests that previously reset the shadow projector. There is no
 * module cache in the v2 projector. */
export function __resetProjectionCacheForTesting(): void {}

export function project(envelopes: ReadonlyArray<ProjectionEnvelopeV2>): ChatViewModel {
  return projectWithMetrics(envelopes).view;
}

export function projectWithMetrics(
  envelopes: ReadonlyArray<ProjectionEnvelopeV2>,
): ProjectionResult {
  const byThread = new Map<string, ProjectionEnvelopeV2[]>();
  const order: string[] = [];
  let outOfOrder = 0;
  for (const envelope of envelopes) {
    let list = byThread.get(envelope.thread_id);
    if (!list) {
      list = [];
      byThread.set(envelope.thread_id, list);
      order.push(envelope.thread_id);
    }
    const previous = list[list.length - 1];
    if (previous && envelope.seq < previous.seq) outOfOrder += 1;
    list.push(envelope);
  }

  let duplicates = 0;
  let droppedAfterTerminal = 0;
  const views: ThreadView[] = [];

  for (const threadId of order) {
    const source = byThread.get(threadId)!;
    const sorted = source.slice().sort((a, b) => a.seq - b.seq);
    const state: MutableThread = {
      thread_id: threadId,
      turn_id: sorted[0]?.turn_id ?? threadId,
      user: null,
      segments: new Map(),
      segmentOrder: [],
      activeSegmentId: null,
      tools: new Map(),
      toolOrder: [],
      terminal: null,
      backgroundChild: null,
      cursor: null,
    };
    const seen = new Set<number>();

    for (const envelope of sorted) {
      if (seen.has(envelope.seq)) {
        duplicates += 1;
        continue;
      }
      seen.add(envelope.seq);
      if (state.terminal !== null) {
        // A background completion has its own thread id, so this only rejects
        // invalid parent-stream traffic after its terminal event.
        droppedAfterTerminal += 1;
        continue;
      }
      state.turn_id = envelope.turn_id;
      if (envelope.cursor) state.cursor = envelope.cursor;
      applyEnvelope(state, envelope);
    }

    const tools = state.toolOrder.map((id) => toToolView(state.tools.get(id)!));
    const segments = state.segmentOrder.map((id) => {
      const segment = state.segments.get(id)!;
      return {
        assistant_segment_id: segment.assistant_segment_id,
        seq: segment.seq,
        text: segment.text,
        meta: segment.meta,
        persisted: segment.persisted,
        files: segment.files.map(copyFile),
        toolCalls: segment.toolCallIds
          .map((id) => state.tools.get(id))
          .filter((tool): tool is MutableTool => tool !== undefined)
          .map(toToolView),
      };
    });
    views.push({
      thread_id: state.thread_id,
      turn_id: state.turn_id,
      user: state.user,
      assistantSegments: segments,
      toolCalls: tools,
      terminal: state.terminal,
      backgroundChild: state.backgroundChild,
      cursor: state.cursor,
    });
  }

  return {
    view: { threads: views },
    metrics: { duplicates, droppedAfterTerminal, outOfOrder },
  };
}

function applyEnvelope(state: MutableThread, envelope: ProjectionEnvelopeV2): void {
  const { payload } = envelope;
  switch (payload.type) {
    case "user_message": {
      if (state.user === null) {
        state.user = {
          seq: envelope.seq,
          ...(envelope.client_message_id !== undefined
            ? { client_message_id: envelope.client_message_id }
            : {}),
          text: payload.data.text,
          files: payload.data.files.map((file) => toFile(file, envelope.seq)),
        };
      }
      return;
    }
    case "assistant_delta": {
      const segment = ensureSegment(state, payload.data.assistant_segment_id, envelope.seq);
      state.activeSegmentId = segment.assistant_segment_id;
      if (!segment.persisted) segment.text += payload.data.text;
      return;
    }
    case "reasoning_delta":
      // Reasoning is intentionally not merged into assistant content.
      return;
    case "assistant_persisted": {
      const segment = ensureSegment(state, payload.data.assistant_segment_id, envelope.seq);
      state.activeSegmentId = segment.assistant_segment_id;
      segment.text = payload.data.text;
      segment.meta = payload.data.meta;
      segment.persisted = true;
      for (const mediaPath of payload.data.meta.media ?? []) {
        addFile(segment.files, {
          path: mediaPath,
          mime: "application/octet-stream",
          size_bytes: 0,
          seq: envelope.seq,
        });
      }
      return;
    }
    case "tool_start": {
      const tool = ensureTool(state, payload.data.tool_call_id);
      tool.name = payload.data.name;
      if (payload.data.arguments !== undefined) {
        tool.arguments = payload.data.arguments;
      }
      if (payload.data.arguments_preview !== undefined) {
        tool.arguments_preview = payload.data.arguments_preview;
      }
      if (state.activeSegmentId) {
        tool.assistant_segment_id = state.activeSegmentId;
        const segment = state.segments.get(state.activeSegmentId)!;
        if (!segment.toolCallIds.includes(tool.tool_call_id)) {
          segment.toolCallIds.push(tool.tool_call_id);
        }
      }
      return;
    }
    case "tool_progress": {
      const tool = ensureTool(state, payload.data.tool_call_id);
      tool.progress.push(payload.data.message);
      return;
    }
    case "tool_end": {
      const tool = ensureTool(state, payload.data.tool_call_id);
      tool.status = payload.data.status;
      tool.error = payload.data.error ?? null;
      if (payload.data.reason !== undefined) tool.reason = payload.data.reason;
      if (payload.data.output_preview !== undefined) tool.output_preview = payload.data.output_preview;
      if (payload.data.duration_ms !== undefined) tool.duration_ms = payload.data.duration_ms;
      return;
    }
    case "file_attached": {
      const file = toFile(payload.data, envelope.seq);
      const owner = payload.data;
      if (owner.assistant_segment_id) {
        const segment = ensureSegment(state, owner.assistant_segment_id, envelope.seq);
        addFile(segment.files, file);
      }
      if (owner.tool_call_id) {
        const tool = ensureTool(state, owner.tool_call_id);
        addFile(tool.files, file);
      }
      return;
    }
    case "turn_terminal":
      state.terminal = {
        outcome: payload.data.outcome,
        error: payload.data.error ?? null,
        tokenUsage: payload.data.token_usage ?? null,
        seq: envelope.seq,
      };
      return;
    case "background/spawn_complete": {
      state.backgroundChild = {
        thread_id: envelope.thread_id,
        turn_id: envelope.turn_id,
        seq: envelope.seq,
        parent_turn_id: payload.data.parent_turn_id,
        response_to_client_message_id:
          payload.data.response_to_client_message_id,
        task_id: payload.data.task_id,
        ...(payload.data.tool_call_id !== undefined
          ? { tool_call_id: payload.data.tool_call_id }
          : {}),
        message_id:
          payload.data.message_id ??
          `${envelope.turn_id}:background:${payload.data.task_id}:${envelope.seq}`,
        source: payload.data.source ?? "background",
        persisted_at:
          payload.data.persisted_at ?? payload.data.meta?.persisted_at ?? "",
        content: payload.data.content,
        files: (payload.data.media ?? payload.data.meta?.media ?? []).map((path) => ({
          path,
          mime: "application/octet-stream",
          size_bytes: 0,
          seq: envelope.seq,
        })),
      };
      return;
    }
  }
}

function ensureSegment(
  state: MutableThread,
  assistantSegmentId: string,
  seq: number,
): MutableSegment {
  const existing = state.segments.get(assistantSegmentId);
  if (existing) return existing;
  const created: MutableSegment = {
    assistant_segment_id: assistantSegmentId,
    seq,
    text: "",
    meta: null,
    persisted: false,
    files: [],
    toolCallIds: [],
  };
  state.segments.set(assistantSegmentId, created);
  state.segmentOrder.push(assistantSegmentId);
  return created;
}

function ensureTool(state: MutableThread, toolCallId: string): MutableTool {
  const existing = state.tools.get(toolCallId);
  if (existing) return existing;
  const created: MutableTool = {
    tool_call_id: toolCallId,
    name: "",
    progress: [],
    status: null,
    error: null,
    files: [],
  };
  state.tools.set(toolCallId, created);
  state.toolOrder.push(toolCallId);
  return created;
}

function toFile(file: ProjectionEnvelopeV2FileRef, seq: number): MutableFile {
  return { path: file.path, mime: file.mime, size_bytes: file.size_bytes, seq };
}

function addFile(target: MutableFile[], file: MutableFile): void {
  const existing = target.find((item) => item.path === file.path);
  if (!existing) {
    target.push(file);
    return;
  }
  // A dedicated file_attached event has richer metadata than media on a
  // persisted message, so upgrade the existing row without moving it.
  if (existing.mime === "application/octet-stream" && file.mime) existing.mime = file.mime;
  if (existing.size_bytes === 0 && file.size_bytes > 0) existing.size_bytes = file.size_bytes;
}

function copyFile(file: MutableFile): ProjectionFileView {
  return { path: file.path, mime: file.mime, size_bytes: file.size_bytes, seq: file.seq };
}

function toToolView(tool: MutableTool): ToolCallView {
  return {
    tool_call_id: tool.tool_call_id,
    name: tool.name,
    ...(tool.arguments !== undefined ? { arguments: tool.arguments } : {}),
    ...(tool.arguments_preview !== undefined ? { arguments_preview: tool.arguments_preview } : {}),
    progress: tool.progress.slice(),
    status: tool.status,
    error: tool.error,
    ...(tool.reason !== undefined ? { reason: tool.reason } : {}),
    ...(tool.output_preview !== undefined ? { output_preview: tool.output_preview } : {}),
    ...(tool.duration_ms !== undefined ? { duration_ms: tool.duration_ms } : {}),
    ...(tool.assistant_segment_id !== undefined
      ? { assistant_segment_id: tool.assistant_segment_id }
      : {}),
    files: tool.files.map(copyFile),
  };
}
