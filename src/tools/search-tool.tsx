import { makeAssistantToolUI } from "@assistant-ui/react";
import { useState, type ComponentType } from "react";
import {
  Search,
  Globe,
  Folder,
  Loader2,
  Check,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

function SearchCard({
  icon: Icon,
  label,
  query,
  result,
  status,
  color,
}: {
  icon: ComponentType<{ size: number; className: string }>;
  label: string;
  query: string;
  result?: string;
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
        <span className="flex-1 truncate text-text">{query}</span>
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
      {expanded && result && (
        <pre className="max-h-48 overflow-auto border-t border-border px-3 py-2 font-mono text-xs text-muted">
          {result}
        </pre>
      )}
    </div>
  );
}

export const WebSearchToolUI = makeAssistantToolUI<
  { query?: string },
  { output?: string }
>({
  toolName: "web_search",
  render: ({ args, result, status }) => (
    <SearchCard
      icon={Search}
      label="search"
      query={args?.query ?? "..."}
      result={result?.output}
      status={status}
      color="text-purple-400"
    />
  ),
});

export const WebFetchToolUI = makeAssistantToolUI<
  { url?: string },
  { output?: string }
>({
  toolName: "web_fetch",
  render: ({ args, result, status }) => (
    <SearchCard
      icon={Globe}
      label="fetch"
      query={args?.url ?? "..."}
      result={result?.output}
      status={status}
      color="text-cyan-400"
    />
  ),
});

export const GrepToolUI = makeAssistantToolUI<
  { pattern?: string },
  { output?: string }
>({
  toolName: "grep",
  render: ({ args, result, status }) => (
    <SearchCard
      icon={Search}
      label="grep"
      query={args?.pattern ?? "..."}
      result={result?.output}
      status={status}
      color="text-orange-400"
    />
  ),
});

export const GlobToolUI = makeAssistantToolUI<
  { pattern?: string },
  { output?: string }
>({
  toolName: "glob",
  render: ({ args, result, status }) => (
    <SearchCard
      icon={Folder}
      label="glob"
      query={args?.pattern ?? "..."}
      result={result?.output}
      status={status}
      color="text-amber-400"
    />
  ),
});
