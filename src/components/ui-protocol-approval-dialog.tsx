import { useEffect, useMemo, useState } from "react";
import { METHODS } from "@/runtime/ui-protocol-bridge";
import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import type {
  ApprovalDecision,
  ApprovalRequestedEvent,
} from "@/runtime/ui-protocol-types";

interface UiProtocolApprovalDialogProps {
  approval: ApprovalRequestedEvent | null;
  sessionId: string;
  topic?: string;
  onResolved: () => void;
}

interface DiffPreviewResult {
  status: string;
  preview?: {
    title?: string | null;
    files?: DiffPreviewFile[];
  };
}

interface DiffPreviewFile {
  path: string;
  old_path?: string | null;
  status: string;
  hunks?: Array<{
    header: string;
    lines?: Array<{
      kind: string;
      content: string;
      old_line?: number | null;
      new_line?: number | null;
    }>;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key].trim() || null
    : null;
}

function approvalPreviewId(
  approval: ApprovalRequestedEvent | null,
): string | null {
  if (!approval?.typed_details) return null;
  const details = approval.typed_details;
  return (
    stringField(details, "preview_id") ??
    stringField(details.diff, "preview_id") ??
    stringField(details.details, "preview_id")
  );
}

function approvalSummary(approval: ApprovalRequestedEvent): string[] {
  const details = approval.typed_details;
  const rows: string[] = [];
  if (approval.risk) rows.push(`Risk: ${approval.risk}`);
  if (approval.approval_kind) rows.push(`Kind: ${approval.approval_kind}`);
  if (isRecord(details)) {
    const operation =
      stringField(details, "operation") ?? stringField(details.diff, "operation");
    const summary =
      stringField(details, "summary") ?? stringField(details.diff, "summary");
    if (operation) rows.push(`Operation: ${operation}`);
    if (summary) rows.push(summary);
  }
  return rows;
}

function linePrefix(kind: string): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "-";
  return " ";
}

function lineClass(kind: string): string {
  if (kind === "added") return "text-emerald-300";
  if (kind === "removed") return "text-rose-300";
  return "text-muted";
}

export function UiProtocolApprovalDialog({
  approval,
  sessionId,
  topic,
  onResolved,
}: UiProtocolApprovalDialogProps) {
  const [responding, setResponding] = useState<ApprovalDecision | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DiffPreviewResult | null>(null);
  const approvalKey = approval?.approval_id ?? null;
  const previewId = approvalPreviewId(approval);
  const summaryRows = useMemo(
    () => (approval ? approvalSummary(approval) : []),
    [approval],
  );

  useEffect(() => {
    setResponding(null);
    setPreviewLoading(false);
    setError(null);
    setPreview(null);
  }, [approvalKey]);

  if (!approval) return null;
  const currentApproval = approval;

  async function respond(decision: ApprovalDecision) {
    setError(null);
    setResponding(decision);
    try {
      const bridge = getActiveBridge(sessionId, topic);
      if (!bridge) throw new Error("UI Protocol bridge is not connected");
      const result = await bridge.respondToApproval(
        currentApproval.approval_id,
        decision,
        currentApproval.approval_scope,
      );
      if (!result.accepted) {
        throw new Error(result.status || "approval response was rejected");
      }
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "approval response failed");
    } finally {
      setResponding(null);
    }
  }

  async function loadPreview() {
    if (!previewId) return;
    setError(null);
    setPreviewLoading(true);
    try {
      const bridge = getActiveBridge(sessionId, topic);
      if (!bridge) throw new Error("UI Protocol bridge is not connected");
      const result = await bridge.callMethod<DiffPreviewResult>(
        METHODS.DIFF_PREVIEW_GET,
        {
          session_id: currentApproval.session_id,
          preview_id: previewId,
        },
      );
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "diff preview failed");
    } finally {
      setPreviewLoading(false);
    }
  }

  const approveLabel = approval.render_hints?.primary_label ?? "Approve";
  const denyLabel = approval.render_hints?.secondary_label ?? "Deny";
  const approveDanger = approval.render_hints?.danger === true;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ui-protocol-approval-title"
    >
      <div className="glass-panel max-h-[88vh] w-full max-w-3xl overflow-hidden rounded-[16px] shadow-lg">
        <div className="border-b border-border px-5 py-4">
          <div className="shell-kicker">Approval Requested</div>
          <h2
            id="ui-protocol-approval-title"
            className="mt-1 text-lg font-semibold text-text-strong"
          >
            {approval.title}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {approval.tool_name}
            {approval.approval_scope ? ` / ${approval.approval_scope}` : ""}
          </p>
        </div>

        <div className="max-h-[58vh] overflow-auto px-5 py-4">
          <p className="whitespace-pre-wrap text-sm leading-6 text-text">
            {approval.body}
          </p>
          {summaryRows.length > 0 && (
            <div className="mt-4 space-y-1 rounded-[12px] border border-border bg-surface-container px-3 py-2 text-sm text-muted">
              {summaryRows.map((row) => (
                <div key={row}>{row}</div>
              ))}
            </div>
          )}

          {previewId && (
            <div className="mt-4">
              <button
                type="button"
                className="glass-pill rounded-[10px] px-3 py-2 text-sm font-medium text-text hover:text-text-strong disabled:opacity-60"
                onClick={() => void loadPreview()}
                disabled={previewLoading}
              >
                {previewLoading ? "Loading diff..." : "Preview diff"}
              </button>
            </div>
          )}

          {preview?.preview && (
            <div className="mt-4 rounded-[12px] border border-border bg-surface-container">
              <div className="border-b border-border px-3 py-2 text-sm font-semibold text-text-strong">
                {preview.preview.title || "Diff preview"}
              </div>
              <div className="space-y-4 px-3 py-3">
                {(preview.preview.files ?? []).map((file) => (
                  <div key={`${file.status}:${file.path}`}>
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-[8px] bg-surface px-2 py-1 font-semibold uppercase text-muted">
                        {file.status}
                      </span>
                      <span className="font-mono text-text">{file.path}</span>
                      {file.old_path && (
                        <span className="font-mono text-muted">
                          from {file.old_path}
                        </span>
                      )}
                    </div>
                    <div className="overflow-x-auto rounded-[10px] bg-black/20 p-3 font-mono text-xs leading-5">
                      {(file.hunks ?? []).map((hunk) => (
                        <div key={hunk.header} className="mb-3 last:mb-0">
                          <div className="text-muted">{hunk.header}</div>
                          {(hunk.lines ?? []).map((line, index) => (
                            <div
                              key={`${hunk.header}:${index}:${line.content}`}
                              className={lineClass(line.kind)}
                            >
                              {linePrefix(line.kind)}
                              {line.content}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {(preview.preview.files ?? []).length === 0 && (
                  <div className="text-sm text-muted">No file changes.</div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-[10px] border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            className="glass-pill rounded-[10px] px-4 py-2 text-sm font-medium text-text hover:text-text-strong disabled:opacity-60"
            onClick={() => void respond("deny")}
            disabled={responding !== null}
          >
            {responding === "deny" ? "Denying..." : denyLabel}
          </button>
          <button
            type="button"
            className={
              approveDanger
                ? "rounded-[10px] bg-rose-500 px-4 py-2 text-sm font-semibold text-white shadow-lg disabled:opacity-60"
                : "rounded-[10px] bg-accent px-4 py-2 text-sm font-semibold text-white shadow-lg disabled:opacity-60"
            }
            onClick={() => void respond("approve")}
            disabled={responding !== null}
          >
            {responding === "approve" ? "Approving..." : approveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
