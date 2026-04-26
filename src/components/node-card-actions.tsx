/**
 * NodeCardActions — M7.9 / W2.G2+G3 cancel + restart-from-node controls
 * for the per-NodeCard tree.
 *
 * Two pieces:
 *
 * 1. `<NodeTreeActions>` renders a header bar above the NodeCard tree
 *    with a single "Cancel" pill while the parent task is still active.
 *    A confirmation modal protects the click — cancelling a long-running
 *    pipeline is a non-trivial action and the contract says "are you
 *    sure?" must come first.
 *
 * 2. `nodeRestartAction` is a per-node renderer plugged into
 *    `<NodeCard nodeAction>`. It shows a "Restart" pill on each failed
 *    node row, and the modal explains the scope ("upstream cached
 *    outputs reused — only this node and its downstream subtree
 *    re-run").
 *
 * Both call into `src/api/tasks.ts` and surface result/error via the
 * provided callbacks so the parent component can flash a toast or
 * update local state — the action shells stay presentational.
 */

import { useState, useCallback } from "react";
import { cancelTask, restartTaskFromNode } from "@/api/tasks";
import type { NodeRow } from "./node-card";

interface ConfirmationModalProps {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmationModal({
  title,
  body,
  confirmLabel,
  destructive,
  pending,
  onConfirm,
  onCancel,
}: ConfirmationModalProps) {
  return (
    <div
      data-testid="node-card-confirm-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="node-card-confirm-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-[14px] border border-muted/15 bg-bg-elevated p-4 shadow-2xl">
        <h2
          id="node-card-confirm-modal-title"
          className="text-sm font-semibold text-text"
        >
          {title}
        </h2>
        <div className="mt-2 text-xs text-muted/90 leading-relaxed">{body}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={onCancel}
            data-testid="node-card-confirm-cancel"
            className="glass-pill rounded-[8px] border border-muted/20 px-3 py-1 text-xs text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            data-testid="node-card-confirm-confirm"
            className={[
              "glass-pill rounded-[8px] border px-3 py-1 text-xs font-medium",
              destructive
                ? "border-red-500/40 bg-red-500/15 text-red-300 hover:bg-red-500/25"
                : "border-accent/40 bg-accent/15 text-accent hover:bg-accent/25",
              "disabled:cursor-not-allowed disabled:opacity-50",
            ].join(" ")}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface NodeTreeActionsProps {
  /** Background task id to cancel — typically the run_pipeline supervisor id. */
  taskId: string;
  /** Whether the parent task is still active (i.e. cancellable). */
  active: boolean;
  /** Optional callback fired after a successful cancel. */
  onCancelled?: (taskId: string) => void;
  /** Optional callback fired on cancel failure. */
  onError?: (message: string) => void;
}

/**
 * Render a "Cancel" pill above the NodeCard tree while the task is
 * active. Clicking it pops a confirmation modal; confirming forwards
 * the click to `cancelTask(taskId)`.
 *
 * G2 acceptance: cancel triggers `POST /api/tasks/{task_id}/cancel`,
 * the server flips the task to `Cancelled`, and the SSE reporter
 * pushes a `cancelled` ToolProgress event the NodeCard reducer
 * consumes — the optimistic state below is purely a "we sent the
 * request" indicator.
 */
export function NodeTreeActions({
  taskId,
  active,
  onCancelled,
  onError,
}: NodeTreeActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [optimisticCancelled, setOptimisticCancelled] = useState(false);

  const onConfirm = useCallback(async () => {
    setPending(true);
    try {
      await cancelTask(taskId);
      setOptimisticCancelled(true);
      setConfirming(false);
      onCancelled?.(taskId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "cancel failed";
      onError?.(message);
    } finally {
      setPending(false);
    }
  }, [taskId, onCancelled, onError]);

  if (!active && !optimisticCancelled) return null;

  return (
    <>
      <div
        data-testid="node-tree-actions"
        data-task-id={taskId}
        data-cancellable={active && !optimisticCancelled ? "true" : "false"}
        className="flex items-center justify-end gap-2 pb-1"
      >
        {optimisticCancelled ? (
          <span
            data-testid="node-tree-cancel-pending"
            className="glass-pill rounded-[8px] border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-mono text-amber-400"
          >
            cancelling…
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            data-testid="node-tree-cancel-button"
            className="glass-pill rounded-[8px] border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-mono text-red-300 hover:bg-red-500/20"
          >
            cancel
          </button>
        )}
      </div>
      {confirming && (
        <ConfirmationModal
          title="Cancel this task?"
          body={
            <>
              <p>
                The runtime will signal every running node to stop at the next
                safe point. In-flight LLM calls will be aborted; outputs
                already on disk are kept.
              </p>
              <p className="mt-2 text-muted/70">
                Use restart-from-node to retry only the failed subtree
                instead of cancelling.
              </p>
            </>
          }
          confirmLabel="Cancel task"
          destructive
          pending={pending}
          onConfirm={onConfirm}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

interface NodeRestartActionProps {
  node: NodeRow;
  /** Background task id passed through from the parent NodeCard. */
  taskId: string;
  onRestarted?: (newTaskId: string) => void;
  onError?: (message: string) => void;
}

/**
 * Per-node "restart" pill rendered inside `<NodeCard nodeAction>` for
 * failed rows. Confirmation modal explains the scope so the user
 * understands upstream cached outputs are reused.
 */
function NodeRestartAction({
  node,
  taskId,
  onRestarted,
  onError,
}: NodeRestartActionProps) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [restarted, setRestarted] = useState(false);

  if (node.status !== "error" || node.nodeId === "__pipeline__") {
    return null;
  }
  if (restarted) {
    return (
      <span
        data-testid="node-restart-done"
        className="glass-pill rounded-[8px] border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-mono text-amber-400"
      >
        restarting…
      </span>
    );
  }

  const onConfirm = async () => {
    setPending(true);
    try {
      const resp = await restartTaskFromNode(taskId, { node_id: node.nodeId });
      setRestarted(true);
      setConfirming(false);
      onRestarted?.(resp.new_task_id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "restart failed";
      onError?.(message);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setConfirming(true);
        }}
        data-testid="node-restart-button"
        data-node-id={node.nodeId}
        className="glass-pill rounded-[8px] border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-mono text-amber-300 hover:bg-amber-500/20"
      >
        restart
      </button>
      {confirming && (
        <ConfirmationModal
          title={`Restart from "${node.nodeId}"?`}
          body={
            <>
              <p>
                Only the failed node and its downstream subtree re-run.
                Upstream cached outputs from earlier nodes are reused — no
                redundant work.
              </p>
              <p className="mt-2 text-muted/70">
                A new background task id is allocated; the failed task stays
                visible in history.
              </p>
            </>
          }
          confirmLabel="Restart subtree"
          pending={pending}
          onConfirm={onConfirm}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/**
 * Build a `NodeCard.nodeAction` renderer bound to a parent task id and
 * shared error/restart callbacks. Pass the result straight to
 * `<NodeCard nodeAction={...}>`.
 */
export function buildNodeRestartRenderer(
  taskId: string,
  callbacks: {
    onRestarted?: (newTaskId: string) => void;
    onError?: (message: string) => void;
  } = {},
): (node: NodeRow) => React.ReactNode {
  return (node: NodeRow) => (
    <NodeRestartAction
      key={`${node.nodeId}-restart`}
      node={node}
      taskId={taskId}
      onRestarted={callbacks.onRestarted}
      onError={callbacks.onError}
    />
  );
}
