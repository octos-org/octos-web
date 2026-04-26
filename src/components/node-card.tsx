/**
 * NodeCard — pipeline node tree rendered under a `run_pipeline` tool-call pill.
 *
 * M8 runtime parity (W1.G1): when the backend dispatches a `run_pipeline`
 * tool, every node registers a child task in the parent session's
 * TaskSupervisor with its parent_task_id wired to the run_pipeline
 * tool_call_id. The supervisor's progress reporter emits one
 * `ToolProgress` SSE event per state transition, all keyed to the
 * parent tool_call_id. The frontend collects them into the existing
 * `Message.toolCalls[i].runtimeStatus` flat list. NodeCard parses that
 * list back into a per-node tree and renders one card per node with a
 * status badge, elapsed timer, and click-to-expand sub-timeline.
 *
 * The component intentionally does not require a new SSE channel:
 * the existing tool_progress channel already carries everything we
 * need (after #889e5e05's tool_call_id fix). NodeCard is a pure
 * projection of `runtimeStatus`.
 *
 * G2/G3 cancel/restart buttons (Track W2) extend this component
 * downstream — they layer onto the per-node status badge slot via the
 * `nodeAction` prop without changing this base layout.
 */

import { useMemo, useState } from "react";
import type { ToolCallInfo, ToolCallRuntimeStatusEntry } from "@/store/message-store";

export type NodeStatus = "pending" | "running" | "complete" | "error";

export interface NodeRow {
  /** Stable node id parsed from progress lines (e.g. "search_topics"). */
  nodeId: string;
  /** Optional resolved model — extracted from "[provider/model]" prefix. */
  model: string | null;
  status: NodeStatus;
  /** All progress entries belonging to this node, in arrival order. */
  entries: ToolCallRuntimeStatusEntry[];
  /** First-seen wall-clock timestamp (ms). */
  startedAt: number;
  /** Last-seen wall-clock timestamp (ms). */
  updatedAt: number;
  /** Final-state timestamp (ms) if the node has completed/failed. */
  finishedAt: number | null;
}

interface NodeCardProps {
  /** The `run_pipeline` (or other tree-bearing) tool call to render. */
  toolCall: ToolCallInfo;
  /** Optional slot — Track W2 G2/G3 plug cancel/restart buttons here. */
  nodeAction?: (node: NodeRow) => React.ReactNode;
}

const NODE_LINE_PATTERN =
  /^([\w./:-]+)\s*(?:\[([^\]]+)\])?\s*[:>-]/;
const FALLBACK_NODE_LINE_PATTERN = /^([\w./:-]+)\s+/;

/**
 * Best-effort projection of a flat `runtimeStatus` list into a per-node
 * tree. Pipeline progress lines look like one of:
 *
 *   "node_id [provider/model]: thinking (iteration 3)"
 *   "node_id: done (12s)"
 *   "node_id [provider/model]: running deep_search"
 *   "Pipeline 'p_id' started (5 nodes)"
 *
 * Lines that don't match either pattern (e.g. the pipeline-level
 * "Pipeline 'foo' started" preamble) attach to a synthetic
 * `__pipeline__` row so they're still visible.
 */
export function projectRuntimeStatusToNodes(
  entries: ToolCallRuntimeStatusEntry[],
): NodeRow[] {
  const byId: Map<string, NodeRow> = new Map();
  const order: string[] = [];

  for (const entry of entries) {
    const text = entry.message.trim();
    if (!text) continue;

    let nodeId: string | null = null;
    let model: string | null = null;

    const match = text.match(NODE_LINE_PATTERN);
    if (match) {
      nodeId = match[1];
      model = match[2] ?? null;
    } else {
      const fallback = text.match(FALLBACK_NODE_LINE_PATTERN);
      if (fallback) {
        nodeId = fallback[1];
      }
    }

    if (!nodeId || nodeId === "Pipeline") {
      // Pipeline-level lines route to a synthetic row so the user
      // still sees the start/finish summary.
      nodeId = "__pipeline__";
      model = null;
    }

    let row = byId.get(nodeId);
    if (!row) {
      row = {
        nodeId,
        model,
        status: "pending",
        entries: [],
        startedAt: entry.ts,
        updatedAt: entry.ts,
        finishedAt: null,
      };
      byId.set(nodeId, row);
      order.push(nodeId);
    }
    if (model && !row.model) row.model = model;
    row.entries.push(entry);
    row.updatedAt = entry.ts;

    // Best-effort status inference — same heuristics the legacy
    // ToolCallRuntimeTimeline used; centralised here so tests can
    // exercise it without rendering.
    const lower = text.toLowerCase();
    if (
      lower.includes("done") ||
      lower.includes("complete") ||
      lower.includes("finished")
    ) {
      row.status = row.status === "error" ? "error" : "complete";
      row.finishedAt = entry.ts;
    } else if (lower.includes("fail") || lower.includes("error")) {
      row.status = "error";
      row.finishedAt = entry.ts;
    } else if (
      lower.includes("running") ||
      lower.includes("thinking") ||
      lower.includes("response received") ||
      row.status === "pending"
    ) {
      row.status = row.status === "complete" || row.status === "error"
        ? row.status
        : "running";
    }
  }

  return order.map((id) => byId.get(id)!).filter(Boolean);
}

function formatElapsed(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "0s";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return `${minutes}m${remSeconds.toString().padStart(2, "0")}s`;
}

function statusBadgeStyle(status: NodeStatus): string {
  switch (status) {
    case "running":
      return "border-accent/30 bg-accent/15 text-accent animate-pulse";
    case "complete":
      return "border-emerald-500/25 bg-emerald-500/12 text-emerald-400";
    case "error":
      return "border-red-500/25 bg-red-500/12 text-red-400";
    default:
      return "border-muted/20 bg-muted/10 text-muted";
  }
}

function statusLabel(status: NodeStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "complete":
      return "done";
    case "error":
      return "failed";
    default:
      return "queued";
  }
}

export function NodeCard({ toolCall, nodeAction }: NodeCardProps) {
  const entries = toolCall.runtimeStatus ?? [];
  const nodes = useMemo(() => projectRuntimeStatusToNodes(entries), [entries]);
  if (nodes.length === 0) return null;

  return (
    <div
      data-testid="node-card-tree"
      data-tool-call-id={toolCall.id}
      data-tool-name={toolCall.name}
      data-node-count={nodes.length}
      className="ml-1 flex flex-col gap-1 border-l border-accent/15 pl-2"
    >
      {nodes.map((node) => (
        <NodeCardRow key={node.nodeId} node={node} nodeAction={nodeAction} />
      ))}
    </div>
  );
}

interface NodeCardRowProps {
  node: NodeRow;
  nodeAction?: (node: NodeRow) => React.ReactNode;
}

function NodeCardRow({ node, nodeAction }: NodeCardRowProps) {
  const [open, setOpen] = useState(false);
  const elapsed = (node.finishedAt ?? node.updatedAt) - node.startedAt;
  return (
    <div
      data-testid="node-card"
      data-node-id={node.nodeId}
      data-node-status={node.status}
      data-node-model={node.model ?? ""}
      className="flex flex-col gap-1 rounded-[10px] border border-muted/10 bg-muted/5 px-2 py-1.5"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            data-testid="node-card-status-badge"
            className={`glass-pill inline-flex items-center gap-1 rounded-[8px] border px-2 py-0.5 text-[10px] font-mono ${statusBadgeStyle(node.status)}`}
          >
            {statusLabel(node.status)}
          </span>
          <span
            data-testid="node-card-id"
            className="truncate font-mono text-[11px] text-text"
          >
            {node.nodeId === "__pipeline__" ? "pipeline" : node.nodeId}
          </span>
          {node.model && (
            <span className="truncate text-[10px] text-muted">
              {node.model}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            data-testid="node-card-elapsed"
            className="font-mono text-[10px] text-muted"
          >
            {formatElapsed(elapsed)}
          </span>
          {nodeAction ? nodeAction(node) : null}
          <span className="text-[10px] text-muted/60">
            {open ? "▾" : "▸"}
          </span>
        </span>
      </button>
      {open && (
        <div
          data-testid="node-card-timeline"
          className="ml-1 flex flex-col gap-0.5 border-l border-accent/15 pl-2 font-mono text-[10px] text-muted/80"
        >
          {node.entries.map((entry, idx) => (
            <div
              key={`${node.nodeId}-${idx}`}
              data-testid="node-card-timeline-entry"
              className="flex gap-1.5 leading-relaxed"
            >
              <span className="shrink-0 text-muted/50">
                +{Math.max(0, Math.floor((entry.ts - node.startedAt) / 1000))}s
              </span>
              <span className="break-words text-muted/70">
                {entry.message.replace(/^\[(info|debug|warn|error)\]\s*/i, "")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Heuristic check used by `chat-thread.tsx` to decide whether a tool
 * call should be rendered with NodeCard (tree) instead of the legacy
 * flat ToolCallRuntimeTimeline. Today we anchor strictly on
 * `run_pipeline` so we don't accidentally re-render every spawn_only
 * tool as a tree; M8 spawn parity (Track W2) opens this up to spawn
 * children that also register child tasks.
 */
export function toolCallRendersAsNodeTree(toolCall: ToolCallInfo): boolean {
  if (toolCall.name === "run_pipeline") return true;
  // Heuristic: any tool whose progress lines repeatedly mention
  // "node " or "Pipeline " is also a tree-bearing call. Falls back to
  // false when there are no entries yet.
  const entries = toolCall.runtimeStatus ?? [];
  if (entries.length === 0) return false;
  const hasNodeMarker = entries.some((entry) =>
    /^\w[\w./:-]*\s*(?:\[[^\]]+\])?\s*[:>-]/.test(entry.message.trim()) &&
    !entry.message.toLowerCase().startsWith("pipeline "),
  );
  return hasNodeMarker;
}
