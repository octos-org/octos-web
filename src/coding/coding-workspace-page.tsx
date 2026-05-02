import { useState } from "react";
import {
  Check,
  Code2,
  FileText,
  GitBranch,
  Home,
  Loader2,
  PackageOpen,
  Play,
  ShieldAlert,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  useCodingAppUi,
  type CodingApproval,
  type CodingDiffPreview,
  type CodingPaneState,
  type CodingTask,
} from "./use-coding-app-ui";
import type { ApprovalTypedDetails } from "./app-ui-protocol";

function typedSummary(details?: ApprovalTypedDetails): string | null {
  if (!details) return null;
  if (details.command?.command_line) return details.command.command_line;
  if (details.command?.argv?.length) return details.command.argv.join(" ");
  if (details.diff?.summary) return details.diff.summary;
  if (details.filesystem?.path) {
    return `${details.filesystem.operation ?? "filesystem"} ${details.filesystem.path}`;
  }
  if (details.network?.url) return details.network.url;
  if (details.network?.host) return details.network.host;
  if (details.sandbox_escalation?.justification) {
    return details.sandbox_escalation.justification;
  }
  return null;
}

function ApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: CodingApproval;
  onApprove: (approval: CodingApproval) => void;
  onDeny: (approval: CodingApproval) => void;
}) {
  const summary = typedSummary(approval.typed_details);
  const pending = !approval.local_status || approval.local_status === "pending";

  return (
    <article
      data-testid="coding-approval-card"
      className="glass-section rounded-[8px] p-4"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-amber-500/12 text-amber-400">
          <ShieldAlert size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text-strong">
              {approval.title}
            </h3>
            {approval.approval_kind && (
              <span className="rounded-[6px] border border-outline px-2 py-0.5 text-[11px] text-muted">
                {approval.approval_kind}
              </span>
            )}
            {approval.risk && (
              <span className="rounded-[6px] bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                {approval.risk}
              </span>
            )}
          </div>
          <p className="mt-2 text-sm leading-relaxed text-text">
            {approval.body}
          </p>
          {summary && (
            <pre className="mt-3 max-h-32 overflow-auto rounded-[8px] bg-code-block-bg p-3 text-xs leading-relaxed text-code-text">
              {summary}
            </pre>
          )}
          <div className="mt-4 flex items-center gap-2">
            <button
              data-testid="coding-approval-approve"
              disabled={!pending}
              onClick={() => onApprove(approval)}
              className="inline-flex items-center gap-2 rounded-[8px] bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-55"
            >
              <Check size={15} />
              Approve
            </button>
            <button
              data-testid="coding-approval-deny"
              disabled={!pending}
              onClick={() => onDeny(approval)}
              className="inline-flex items-center gap-2 rounded-[8px] border border-outline px-3 py-2 text-sm font-medium text-text hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-55"
            >
              <X size={15} />
              Deny
            </button>
            {!pending && (
              <span
                data-testid="coding-approval-status"
                className="ml-1 text-xs uppercase tracking-[0.12em] text-muted"
              >
                {approval.local_status}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function DiffPreviewPanel({ diffs }: { diffs: CodingDiffPreview[] }) {
  return (
    <section data-testid="coding-diff-preview" className="space-y-3">
      <div className="flex items-center gap-2">
        <FileText size={15} className="text-muted" />
        <h2 className="text-sm font-semibold text-text-strong">Diff Preview</h2>
      </div>
      {diffs.length === 0 ? (
        <div className="text-sm text-muted">No diff previews yet.</div>
      ) : (
        diffs.map((diff) => (
          <article key={diff.id} className="rounded-[8px] border border-outline bg-surface-container">
            <div className="border-b border-outline px-3 py-2 text-sm font-medium text-text-strong">
              {diff.result.preview?.title ?? "Inline patch"}
            </div>
            <div className="max-h-72 overflow-auto font-mono text-xs">
              {diff.result.preview?.files?.map((file) => (
                <div key={`${diff.id}:${file.path}`}>
                  <div className="bg-surface-elevated px-3 py-1 text-text-strong">
                    {file.status ?? "modified"} {file.path}
                  </div>
                  {file.hunks?.map((hunk, hunkIndex) => (
                    <div key={`${file.path}:${hunkIndex}`}>
                      <div className="px-3 py-1 text-accent">{hunk.header}</div>
                      {hunk.lines?.map((line, lineIndex) => {
                        const kind = line.kind ?? "context";
                        const sign =
                          kind === "added" ? "+" : kind === "removed" ? "-" : " ";
                        const tone =
                          kind === "added"
                            ? "bg-emerald-500/10 text-emerald-300"
                            : kind === "removed"
                              ? "bg-red-500/10 text-red-300"
                              : "text-text";
                        return (
                          <div
                            key={`${file.path}:${hunkIndex}:${lineIndex}`}
                            className={`px-3 py-0.5 ${tone}`}
                          >
                            <span className="mr-2 text-muted">
                              {line.old_line ?? ""}
                              {" "}
                              {line.new_line ?? ""}
                            </span>
                            <span>{sign}</span>
                            <span>{line.content}</span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </article>
        ))
      )}
    </section>
  );
}

function InspectorPanels({
  panes,
  tasks,
  taskOutputs,
}: {
  panes: CodingPaneState;
  tasks: CodingTask[];
  taskOutputs: Record<string, string>;
}) {
  return (
    <section className="grid gap-3 xl:grid-cols-2">
      <div className="rounded-[8px] border border-outline bg-surface-container p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-strong">
          <FileText size={15} className="text-muted" />
          Workspace
        </div>
        <div data-testid="coding-workspace-pane" className="space-y-1 text-xs text-text">
          {(panes.workspace ?? []).slice(0, 12).map((entry) => (
            <div key={entry.path} className="flex gap-2">
              <span className="text-muted">{entry.kind ?? "file"}</span>
              <span className="truncate">{entry.path}</span>
            </div>
          ))}
          {(panes.workspace ?? []).length === 0 && (
            <div className="text-muted">No workspace snapshot yet.</div>
          )}
        </div>
      </div>

      <div className="rounded-[8px] border border-outline bg-surface-container p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-strong">
          <PackageOpen size={15} className="text-muted" />
          Artifacts
        </div>
        <div data-testid="coding-artifacts-pane" className="space-y-1 text-xs text-text">
          {(panes.artifacts ?? []).slice(0, 10).map((item) => (
            <div key={`${item.path}:${item.title}`} className="truncate">
              {item.title ?? item.path}
            </div>
          ))}
          {(panes.artifacts ?? []).length === 0 && (
            <div className="text-muted">No artifacts yet.</div>
          )}
        </div>
      </div>

      <div className="rounded-[8px] border border-outline bg-surface-container p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-strong">
          <GitBranch size={15} className="text-muted" />
          Git
        </div>
        <div data-testid="coding-git-pane" className="space-y-1 text-xs text-text">
          {(panes.gitStatus ?? []).slice(0, 10).map((item) => (
            <div key={`${item.path}:${item.status}`} className="flex gap-2">
              <span className="text-muted">{item.status ?? "changed"}</span>
              <span className="truncate">{item.path}</span>
            </div>
          ))}
          {(panes.gitHistory ?? []).slice(0, 4).map((item) => (
            <div key={`${item.commit}:${item.summary}`} className="truncate text-muted">
              {item.commit} {item.summary}
            </div>
          ))}
          {(panes.gitStatus ?? []).length === 0 && (panes.gitHistory ?? []).length === 0 && (
            <div className="text-muted">No git snapshot yet.</div>
          )}
        </div>
      </div>

      <div className="rounded-[8px] border border-outline bg-surface-container p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-strong">
          <Terminal size={15} className="text-muted" />
          Task Output
        </div>
        <div data-testid="coding-task-output-pane" className="space-y-2 text-xs text-text">
          {tasks.slice(0, 4).map((task) => (
            <div key={task.id}>
              <div className="font-medium text-text-strong">{task.title}</div>
              <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-[8px] bg-code-block-bg p-2 text-code-text">
                {taskOutputs[task.id] || task.detail || "No output loaded yet."}
              </pre>
            </div>
          ))}
          {tasks.length === 0 && <div className="text-muted">No task output yet.</div>}
        </div>
      </div>
    </section>
  );
}

export function CodingWorkspacePage() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const {
    sessionId,
    connectionState,
    turnStatus,
    activeTurnId,
    logs,
    approvals,
    tasks,
    panes,
    diffs,
    taskOutputs,
    submitPrompt,
    interruptTurn,
    respondApproval,
  } = useCodingAppUi();

  return (
    <div className="chat-shell flex h-screen flex-col bg-surface-dark p-3">
      <header className="glass-toolbar mb-3 flex items-center gap-3 rounded-[8px] px-4 py-3">
        <button
          onClick={() => navigate("/")}
          className="glass-icon-button rounded-[8px] p-2"
          title="Home"
          aria-label="Home"
        >
          <Home size={16} />
        </button>
        <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-accent-container text-accent">
          <Code2 size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="shell-kicker">Coding Workspace</div>
          <div className="truncate text-lg font-semibold text-text-strong">
            AppUi / UI Protocol v1
          </div>
        </div>
        <div
          data-testid="coding-connection-state"
          className="flex items-center gap-2 rounded-[8px] border border-outline px-3 py-2 text-xs text-muted"
        >
          {connectionState === "connecting" && (
            <Loader2 size={13} className="animate-spin" />
          )}
          {connectionState}
        </div>
        <div
          data-testid="coding-turn-status"
          className="rounded-[8px] border border-outline px-3 py-2 text-xs text-muted"
        >
          {turnStatus}
        </div>
      </header>

      <main className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="glass-panel flex min-h-0 flex-col rounded-[8px]">
          <div className="border-b border-outline px-4 py-3">
            <div className="shell-kicker">Session</div>
            <div
              data-testid="coding-session-id"
              className="mt-1 truncate font-mono text-xs text-muted"
            >
              {sessionId}
            </div>
          </div>
          <div
            data-testid="coding-log"
            className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-4"
          >
            {logs.map((entry) => (
              <div
                key={entry.id}
                className={`message-card rounded-[8px] px-3 py-2 text-sm leading-relaxed ${
                  entry.kind === "user"
                    ? "message-card-user ml-auto max-w-[78%]"
                    : "message-card-assistant mr-auto max-w-[86%]"
                }`}
              >
                <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted">
                  {entry.kind}
                </div>
                <div className="whitespace-pre-wrap text-text">{entry.text}</div>
              </div>
            ))}
          </div>
          <form
            className="border-t border-outline p-3"
            onSubmit={(event) => {
              event.preventDefault();
              submitPrompt(prompt);
              setPrompt("");
            }}
          >
            <div className="flex gap-2">
              <textarea
                data-testid="coding-prompt-input"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={2}
                className="min-h-12 flex-1 resize-none rounded-[8px] border border-outline bg-surface-container px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
                placeholder="Describe the coding task"
              />
              <button
                data-testid="coding-submit"
                type="submit"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[8px] bg-accent text-white hover:bg-accent-dim"
                title="Start turn"
                aria-label="Start turn"
              >
                <Play size={17} />
              </button>
              <button
                data-testid="coding-interrupt"
                type="button"
                disabled={!activeTurnId}
                onClick={interruptTurn}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[8px] border border-outline text-text hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-45"
                title="Interrupt turn"
                aria-label="Interrupt turn"
              >
                <Square size={15} />
              </button>
            </div>
          </form>
        </section>

        <aside className="flex min-h-0 flex-col gap-3">
          <section
            data-testid="coding-approvals"
            className="glass-panel min-h-0 flex-1 overflow-auto rounded-[8px] p-3"
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="shell-kicker">Coding Only</div>
                <h2 className="text-sm font-semibold text-text-strong">
                  Approvals
                </h2>
              </div>
              <span className="rounded-[6px] bg-surface-container px-2 py-1 text-xs text-muted">
                {approvals.filter((approval) => !approval.local_status || approval.local_status === "pending").length}
              </span>
            </div>
            <div className="space-y-3">
              {approvals.length === 0 ? (
                <div className="shell-empty-state rounded-[8px] p-4 text-sm text-muted">
                  Approval requests for this coding session will appear here.
                </div>
              ) : (
                approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.approval_id}
                    approval={approval}
                    onApprove={(item) => respondApproval(item, "approve")}
                    onDeny={(item) => respondApproval(item, "deny")}
                  />
                ))
              )}
            </div>
          </section>

          <section className="glass-panel max-h-[36%] overflow-auto rounded-[8px] p-3">
            <div className="mb-3 flex items-center gap-2">
              <Terminal size={15} className="text-muted" />
              <h2 className="text-sm font-semibold text-text-strong">Tasks</h2>
            </div>
            {tasks.length === 0 ? (
              <div className="text-sm text-muted">No task updates yet.</div>
            ) : (
              <div className="space-y-2">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className="rounded-[8px] border border-outline bg-surface-container p-3"
                  >
                    <div className="text-sm font-medium text-text-strong">
                      {task.title}
                    </div>
                    <div className="mt-1 text-xs text-muted">{task.state}</div>
                    {task.detail && (
                      <div className="mt-2 text-xs leading-relaxed text-text">
                        {task.detail}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </main>

      <section className="glass-panel mt-3 max-h-[36vh] overflow-auto rounded-[8px] p-3">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <DiffPreviewPanel diffs={diffs} />
          <InspectorPanels panes={panes} tasks={tasks} taskOutputs={taskOutputs} />
        </div>
      </section>
    </div>
  );
}
