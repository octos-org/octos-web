import { makeAssistantToolUI } from "@assistant-ui/react";
import { useState } from "react";
import {
  Terminal,
  Check,
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

export const ShellToolUI = makeAssistantToolUI<
  { command?: string },
  { output?: string }
>({
  toolName: "shell",
  render: ({ args, result, status }) => {
    const [expanded, setExpanded] = useState(status.type === "running");
    const command = args?.command ?? "...";
    const output = result?.output ?? "";

    return (
      <div className="my-2 overflow-hidden rounded-lg border border-border bg-surface-dark">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-light"
        >
          <Terminal size={14} className="shrink-0 text-green-400" />
          <code className="flex-1 truncate text-text">{command}</code>
          {status.type === "running" && (
            <Loader2 size={14} className="animate-spin text-accent" />
          )}
          {status.type === "complete" && (
            <Check size={14} className="text-green-400" />
          )}
          {status.type === "incomplete" && (
            <X size={14} className="text-red-400" />
          )}
          {expanded ? (
            <ChevronDown size={14} className="text-muted" />
          ) : (
            <ChevronRight size={14} className="text-muted" />
          )}
        </button>
        {expanded && output && (
          <pre className="max-h-64 overflow-auto border-t border-border px-3 py-2 font-mono text-xs text-muted">
            {output}
          </pre>
        )}
      </div>
    );
  },
});
