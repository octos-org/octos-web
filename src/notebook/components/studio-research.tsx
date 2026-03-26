/**
 * Research UI — Issues #36, #37, #38
 * Fast search + deep research + import as source.
 */
import { useState } from "react";
import { Loader2, Wand2, Search, Download, Plus, RotateCcw } from "lucide-react";
import { NotebookMarkdown } from "./notebook-markdown";
import { addSourceText, addSourceUrl } from "../api/sources";

type Mode = "fast" | "deep";

interface SearchResult {
  title: string;
  url: string;
  summary: string;
}

function parseSearchResults(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  // Try to parse numbered results: "1. **Title** - URL\n   Summary"
  const regex = /(?:^|\n)\d+\.\s*\*{0,2}(.+?)\*{0,2}\s*[-—]\s*(https?:\/\/\S+)\s*\n\s*(.+?)(?=\n\d+\.|$)/gs;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    results.push({ title: match[1].trim(), url: match[2].trim(), summary: match[3].trim() });
  }

  // Fallback: try JSON array
  if (results.length === 0) {
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const item of parsed) {
          if (item.title && item.url) {
            results.push({ title: item.title, url: item.url, summary: item.summary || "" });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return results;
}

type DeepPhase = "idle" | "planning" | "searching" | "analyzing" | "report";

interface Props {
  notebookId: string;
  chatApi: (notebookId: string, message: string) => Promise<string>;
}

export function ResearchUI({ notebookId, chatApi }: Props) {
  const [mode, setMode] = useState<Mode>("fast");

  return (
    <div className="p-4 space-y-4">
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setMode("fast")}
          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
            mode === "fast" ? "border-accent bg-accent/15 text-accent" : "border-border text-text hover:border-accent/50"
          }`}
        >
          快速搜索
        </button>
        <button
          onClick={() => setMode("deep")}
          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
            mode === "deep" ? "border-accent bg-accent/15 text-accent" : "border-border text-text hover:border-accent/50"
          }`}
        >
          深度研究
        </button>
      </div>

      {mode === "fast" ? (
        <FastResearch notebookId={notebookId} chatApi={chatApi} />
      ) : (
        <DeepResearch notebookId={notebookId} chatApi={chatApi} />
      )}
    </div>
  );
}

function FastResearch({ notebookId, chatApi }: Props) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [rawResult, setRawResult] = useState<string | null>(null);
  const [imported, setImported] = useState<Set<number>>(new Set());

  const search = async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setResults([]);
    setRawResult(null);
    setImported(new Set());
    try {
      const content = await chatApi(notebookId, `Search the web for: ${query}. Return 5-10 results with title, URL, and brief summary.`);
      setRawResult(content);
      setResults(parseSearchResults(content));
    } catch {
      setRawResult("Search failed.");
    } finally {
      setLoading(false);
    }
  };

  const importAsSource = async (idx: number, result: SearchResult) => {
    await addSourceUrl(notebookId, result.url);
    setImported((prev) => new Set(prev).add(idx));
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
          placeholder="搜索..."
          className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
        />
        <button onClick={search} disabled={!query.trim() || loading} className="rounded-lg bg-accent px-3 py-2 text-white disabled:opacity-50">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
        </button>
      </div>

      {results.length > 0 ? (
        <div className="space-y-2">
          {results.map((r, i) => (
            <div key={i} className="rounded-lg border border-border bg-surface p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-accent hover:underline">
                    {r.title}
                  </a>
                  <p className="text-xs text-muted truncate">{r.url}</p>
                  <p className="mt-1 text-xs text-text">{r.summary}</p>
                </div>
                <button
                  onClick={() => importAsSource(i, r)}
                  disabled={imported.has(i)}
                  className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs whitespace-nowrap transition ${
                    imported.has(i)
                      ? "border-green-500/30 text-green-400"
                      : "border-border text-text hover:border-accent/50"
                  }`}
                >
                  {imported.has(i) ? "已导入" : <><Plus size={12} /> 导入</>}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : rawResult ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <NotebookMarkdown text={rawResult} className="text-sm" />
        </div>
      ) : null}
    </div>
  );
}

function DeepResearch({ notebookId, chatApi }: Props) {
  const [topic, setTopic] = useState("");
  const [phase, setPhase] = useState<DeepPhase>("idle");
  const [report, setReport] = useState<string | null>(null);
  const [imported, setImported] = useState(false);

  const start = async () => {
    if (!topic.trim()) return;
    setPhase("planning");
    setReport(null);
    setImported(false);

    try {
      // Simulate phases with a single API call
      await new Promise((r) => setTimeout(r, 800));
      setPhase("searching");
      await new Promise((r) => setTimeout(r, 800));
      setPhase("analyzing");

      const content = await chatApi(
        notebookId,
        `Conduct deep research on: ${topic}. Create a research plan with 4-6 search angles, then provide findings for each angle with citations.`,
      );
      setPhase("report");
      setReport(content);
    } catch {
      setReport("Research failed.");
      setPhase("report");
    }
  };

  const importAsSource = async () => {
    if (!report) return;
    await addSourceText(notebookId, { text: report, filename: `Research: ${topic}` });
    setImported(true);
  };

  const phases: { key: DeepPhase; label: string }[] = [
    { key: "planning", label: "规划中" },
    { key: "searching", label: "搜索中" },
    { key: "analyzing", label: "分析中" },
    { key: "report", label: "报告" },
  ];

  if (phase === "idle") {
    return (
      <div className="space-y-4">
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") start(); }}
          placeholder="输入研究主题..."
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
        />
        <button onClick={start} disabled={!topic.trim()} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-50">
          <Wand2 size={14} /> 开始研究
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Progress indicator (#37) */}
      <div className="flex items-center gap-2">
        {phases.map((p, i) => {
          const phaseIdx = phases.findIndex((pp) => pp.key === phase);
          const done = i < phaseIdx;
          const active = i === phaseIdx;
          return (
            <div key={p.key} className="flex items-center gap-1">
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold transition ${
                  done ? "bg-green-500/20 text-green-400" : active ? "bg-accent/20 text-accent" : "bg-surface-light text-muted"
                }`}
              >
                {done ? "\u2713" : i + 1}
              </div>
              <span className={`text-xs ${active ? "text-accent font-medium" : done ? "text-green-400" : "text-muted"}`}>
                {p.label}
              </span>
              {i < phases.length - 1 && <div className={`mx-1 h-px w-4 ${done ? "bg-green-400" : "bg-border"}`} />}
            </div>
          );
        })}
      </div>

      {phase !== "report" && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" />
          {phase === "planning" && "Creating research plan..."}
          {phase === "searching" && "Searching multiple angles..."}
          {phase === "analyzing" && "Analyzing findings..."}
        </div>
      )}

      {report && (
        <>
          <div className="flex items-center justify-between">
            <button onClick={() => { setPhase("idle"); setReport(null); }} className="flex items-center gap-1 text-xs text-muted hover:text-accent">
              <RotateCcw size={12} /> 新研究
            </button>
            {/* #38: import as source */}
            <button
              onClick={importAsSource}
              disabled={imported}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
                imported ? "border-green-500/30 text-green-400" : "border-border text-text hover:border-accent/50"
              }`}
            >
              {imported ? "已导入" : <><Download size={14} /> 导入为来源</>}
            </button>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <NotebookMarkdown text={report} className="text-sm" />
          </div>
        </>
      )}
    </div>
  );
}
