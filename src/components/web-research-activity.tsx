import { useId, useState } from "react";
import { Check, ChevronDown, ChevronRight, Globe, Loader2, Search, TriangleAlert } from "lucide-react";
import type { ThreadMessage, ThreadToolCall } from "@/store/thread-store";

export function isWebResearchTool(tool: ThreadToolCall): boolean {
  return tool.name === "web_search" || tool.name === "web_fetch";
}

export function isWebResearchMessage(message: ThreadMessage): boolean {
  return message.role === "assistant" && !message.text.trim() && message.files.length === 0
    && message.toolCalls.length > 0 && message.toolCalls.every(isWebResearchTool);
}

/** Presentation only: preserve narrative/file boundaries and all canonical tool IDs. */
export function groupWebResearchMessages(messages: ThreadMessage[]): ThreadMessage[] {
  const rows: ThreadMessage[] = [];
  for (const message of messages) {
    const previous = rows.at(-1);
    if (previous && isWebResearchMessage(previous) && isWebResearchMessage(message)) {
      rows[rows.length - 1] = {
        ...previous,
        toolCalls: [...previous.toolCalls, ...message.toolCalls],
        status: message.status,
        timestamp: message.timestamp,
        meta: undefined,
      };
    } else {
      rows.push(message);
    }
  }
  return rows;
}

function argument(tool: ThreadToolCall, keys: string[]): string | undefined {
  let args = tool.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return undefined; }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function description(tool: ThreadToolCall): string {
  if (tool.name === "web_search") return argument(tool, ["query", "q", "search"]) ?? "Web search";
  const raw = argument(tool, ["url", "uri"]);
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" || url.protocol === "http:") {
        // Show useful source context without credential-bearing URL parameters.
        return url.hostname.replace(/^www\./, "") + (url.pathname === "/" ? "" : url.pathname);
      }
    } catch { /* Malformed or incomplete streaming arguments have a neutral label. */ }
  }
  return "Webpage";
}

function StatusIcon({ status }: { status: ThreadToolCall["status"] }) {
  if (status === "running") return <Loader2 size={14} className="shrink-0 animate-spin text-accent motion-reduce:animate-none" aria-label="Running" />;
  if (status === "error") return <TriangleAlert size={14} className="shrink-0 text-red-500" aria-label="Failed" />;
  return <Check size={14} className="shrink-0 text-muted" aria-label="Completed" />;
}

function ResearchStep({ tool, threadId }: { tool: ThreadToolCall; threadId: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const label = tool.name === "web_search" ? "Search" : "Read page";
  const Icon = tool.name === "web_search" ? Search : Globe;
  const latest = tool.progress.at(-1)?.message;
  return (
    <li data-testid="tool-call-bubble" data-thread-id={threadId}
      data-tool-call-id={tool.id || undefined} data-tool-status={tool.status}
      className="min-w-0">
      <button type="button" onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded} aria-controls={id}
        className="flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-accent">
        <Icon size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] text-muted">{label}</span>
          <span className="block truncate text-xs text-text" title={description(tool)}>{description(tool)}</span>
          {tool.retryCount > 0 && <span className="text-[11px] text-muted">Retried {tool.retryCount} time{tool.retryCount === 1 ? "" : "s"}</span>}
        </span>
        <StatusIcon status={tool.status} />
        {expanded ? <ChevronDown size={12} className="shrink-0 text-muted" /> : <ChevronRight size={12} className="shrink-0 text-muted" />}
      </button>
      {tool.status === "error" && !expanded && (
        <p className="mb-2 ml-8 break-words text-xs text-red-500">{latest || "This step failed. Open details for more information."}</p>
      )}
      {expanded && <div id={id} className="mb-2 ml-8 max-h-48 overflow-auto border-l border-border pl-3 text-xs text-muted">
        <p className="mb-1">{tool.status === "running" ? "In progress" : tool.status === "error" ? "Failed" : "Completed"}</p>
        {tool.progress.length > 0 ? tool.progress.map((entry, index) => (
          <p key={index} className="whitespace-pre-wrap break-words py-0.5">{entry.message}</p>
        )) : <p>No additional details.</p>}
      </div>}
    </li>
  );
}

export function WebResearchActivity({ toolCalls, threadId }: { toolCalls: ThreadToolCall[]; threadId: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const searches = toolCalls.filter(tool => tool.name === "web_search").length;
  const pages = toolCalls.length - searches;
  const running = toolCalls.filter(tool => tool.status === "running");
  const failures = toolCalls.filter(tool => tool.status === "error").length;
  const status = running.length ? "running" : failures ? "error" : "complete";
  const active = running.at(-1);
  const title = active ? (active.name === "web_search" ? "Searching the web" : "Reading webpages")
    : failures ? "Web research needs attention" : "Web research complete";
  const counts = [searches ? `${searches} search${searches === 1 ? "" : "es"}` : "",
    pages ? `${pages} page${pages === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  if (!toolCalls.length) return null;
  return (
    <section data-testid="web-research-activity" data-tool-status={status}
      className="w-full min-w-0 overflow-hidden rounded-xl border border-border/70 bg-surface-container/40">
      <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls={id}
        className="flex w-full min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-accent">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-elevated text-muted"><Globe size={16} aria-hidden="true" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-text" aria-live="polite">{title}</span>
          <span className="mt-0.5 block text-xs text-muted">{counts}{failures > 0 && <span className="ml-2 text-red-500">{failures} failed</span>}</span>
          {active && <span className="mt-1 block truncate text-xs text-muted" title={description(active)}>{description(active)}</span>}
        </span>
        <StatusIcon status={status} />
        {expanded ? <ChevronDown size={14} className="shrink-0 text-muted" /> : <ChevronRight size={14} className="shrink-0 text-muted" />}
      </button>
      {expanded && <ol id={id} aria-label="Web research steps" className="m-0 max-h-80 list-none overflow-auto border-t border-border/60 px-2 py-2">
        {toolCalls.map((tool, index) => <ResearchStep key={tool.id || `step-${index}`} tool={tool} threadId={threadId} />)}
      </ol>}
    </section>
  );
}
