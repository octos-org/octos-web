import { makeAssistantToolUI } from "@assistant-ui/react";
import { useState, type ComponentType } from "react";
import {
  File,
  FilePlus,
  FileEdit,
  Check,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

function FileCard({
  icon: Icon,
  label,
  path,
  content,
  status,
  color,
}: {
  icon: ComponentType<{ size: number; className: string }>;
  label: string;
  path: string;
  content?: string;
  status: { type: string };
  color: string;
}) {
  const [expanded, setExpanded] = useState(status.type === "running");

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-surface-dark">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-light"
      >
        <Icon size={14} className={`shrink-0 ${color}`} />
        <span className="text-xs text-muted">{label}</span>
        <code className="flex-1 truncate text-text">{path}</code>
        {status.type === "running" && (
          <Loader2 size={14} className="animate-spin text-accent" />
        )}
        {status.type === "complete" && (
          <Check size={14} className="text-green-400" />
        )}
        {expanded ? (
          <ChevronDown size={14} className="text-muted" />
        ) : (
          <ChevronRight size={14} className="text-muted" />
        )}
      </button>
      {expanded && content && (
        <pre className="max-h-64 overflow-auto border-t border-border px-3 py-2 font-mono text-xs text-muted">
          {content}
        </pre>
      )}
    </div>
  );
}

export const ReadFileToolUI = makeAssistantToolUI<
  { path?: string },
  { content?: string }
>({
  toolName: "read_file",
  render: ({ args, result, status }) => (
    <FileCard
      icon={File}
      label="read"
      path={args?.path ?? "..."}
      content={result?.content}
      status={status}
      color="text-blue-400"
    />
  ),
});

export const WriteFileToolUI = makeAssistantToolUI<
  { path?: string },
  unknown
>({
  toolName: "write_file",
  render: ({ args, status }) => (
    <FileCard
      icon={FilePlus}
      label="write"
      path={args?.path ?? "..."}
      status={status}
      color="text-green-400"
    />
  ),
});

export const EditFileToolUI = makeAssistantToolUI<
  { path?: string },
  unknown
>({
  toolName: "edit_file",
  render: ({ args, status }) => (
    <FileCard
      icon={FileEdit}
      label="edit"
      path={args?.path ?? "..."}
      status={status}
      color="text-yellow-400"
    />
  ),
});
