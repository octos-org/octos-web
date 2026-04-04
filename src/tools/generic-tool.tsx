import { makeAssistantToolUI } from "@assistant-ui/react";
import { useState } from "react";
import {
  Wrench,
  Loader2,
  Check,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

export const GenericToolUI = makeAssistantToolUI<
  Record<string, unknown>,
  unknown
>({
  toolName: "*",
  render: ({ args, result, status, toolName }) => {
    const [expanded, setExpanded] = useState(status.type === "running");

    return (
      <div className="my-2 overflow-hidden rounded-lg border border-border bg-surface-dark">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-light"
        >
          <Wrench size={14} className="shrink-0 text-muted" />
          <span className="font-medium text-text">{toolName}</span>
          {status.type === "running" && (
            <Loader2 size={14} className="animate-spin text-accent" />
          )}
          {status.type === "complete" && (
            <Check size={14} className="text-green-400" />
          )}
          <span className="flex-1" />
          {expanded ? (
            <ChevronDown size={14} className="text-muted" />
          ) : (
            <ChevronRight size={14} className="text-muted" />
          )}
        </button>
        {expanded && (
          <div className="border-t border-border px-3 py-2">
            {args && Object.keys(args).length > 0 && (
              <pre className="mb-2 text-xs text-muted">
                {JSON.stringify(args, null, 2)}
              </pre>
            )}
            {result != null && (
              <pre className="max-h-48 overflow-auto text-xs text-muted/70">
                {typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    );
  },
});
