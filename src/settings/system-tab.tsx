import { useState, useEffect, useRef, useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  Loader2,
  CheckCircle,
  BarChart3,
  ListChecks,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Route,
  Package,
  Terminal,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import {
  fetchOperatorSummary,
  fetchOperatorTasks,
  type OperatorSummary,
  type OperatorTasksResponse,
  type BreakdownEntry,
} from "./settings-api";
import { API_BASE, TOKEN_KEY, ADMIN_TOKEN_KEY } from "@/lib/constants";

const AUTO_REFRESH_MS = 30_000;
const MAX_LOG_LINES = 500;

// ── Metric card ──

function MetricCard({
  label,
  value,
  variant = "default",
}: {
  label: string;
  value: number | string;
  variant?: "default" | "error" | "warning" | "success";
}) {
  const color = {
    default: "text-text-strong",
    error: "text-red-400",
    warning: "text-yellow-400",
    success: "text-green-400",
  }[variant];

  const ring = {
    default: "border-border/30",
    error: "border-red-400/30 bg-red-400/5",
    warning: "border-yellow-400/30 bg-yellow-400/5",
    success: "border-green-400/30 bg-green-400/5",
  }[variant];

  return (
    <div
      className={`rounded-xl border px-4 py-3 transition ${ring}`}
    >
      <div className={`text-2xl font-bold tabular-nums ${color}`}>
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted">{label}</div>
    </div>
  );
}

// ── Breakdown badge ──

function BreakdownBadge({ entry }: { entry: BreakdownEntry }) {
  const parts = Object.entries(entry)
    .filter(([k]) => k !== "count")
    .map(([, v]) => String(v));
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-dark/60 px-2 py-0.5 text-[10px] font-medium text-muted">
      {parts.join(" / ")}
      <span className="font-bold text-text">{entry.count}</span>
    </span>
  );
}

// ── Task status badge ──

function TaskStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    queued: "bg-surface-dark/60 text-muted",
    running: "bg-accent/15 text-accent",
    verifying: "bg-yellow-400/15 text-yellow-400",
    ready: "bg-green-400/15 text-green-400",
    failed: "bg-red-400/15 text-red-400",
  };
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${styles[status] ?? styles.queued}`}
    >
      {status}
    </span>
  );
}

// ── Collapsible section ──

function CollapsibleSection({
  icon,
  iconBg,
  iconColor,
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass-section rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-6 text-left hover:bg-surface-container/30 transition"
      >
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconBg} ${iconColor}`}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-text-strong">{title}</h3>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        <span className="text-muted">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {open && <div className="px-6 pb-6">{children}</div>}
    </div>
  );
}

// ── Retry Bucket State panel ──

function RetryBucketPanel({
  entries,
}: {
  entries: BreakdownEntry[];
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-xl bg-surface-dark/50 px-4 py-6 text-center">
        <p className="text-sm text-muted">No retry events recorded</p>
      </div>
    );
  }

  // Group by variant
  const byVariant: Record<string, BreakdownEntry[]> = {};
  for (const entry of entries) {
    const variant = String(entry.variant ?? "unknown");
    (byVariant[variant] ??= []).push(entry);
  }

  return (
    <div className="space-y-4">
      {Object.entries(byVariant).map(([variant, items]) => (
        <div key={variant}>
          <div className="mb-2 text-xs font-medium text-yellow-400 uppercase tracking-wider">
            {variant}
          </div>
          <div className="flex flex-wrap gap-2">
            {items.map((entry, i) => (
              <BreakdownBadge key={i} entry={entry} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Routing Decisions panel ──

function RoutingDecisionsPanel({
  entries,
  cheapTotal,
  strongTotal,
}: {
  entries: BreakdownEntry[];
  cheapTotal: number;
  strongTotal: number;
}) {
  const grandTotal = cheapTotal + strongTotal;
  const cheapPct =
    grandTotal > 0 ? Math.round((cheapTotal / grandTotal) * 100) : 0;
  const strongPct = grandTotal > 0 ? 100 - cheapPct : 0;

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      {grandTotal > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>
              Cheap{" "}
              <span className="font-bold text-green-400">{cheapPct}%</span>
            </span>
            <span>
              <span className="font-bold text-accent">{strongPct}%</span>{" "}
              Strong
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-surface-dark/60 overflow-hidden">
            <div
              className="h-full rounded-full bg-gradient-to-r from-green-400 to-accent transition-all duration-500"
              style={{ width: `${cheapPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] text-muted">
            <span>{cheapTotal} cheap calls</span>
            <span>{strongTotal} strong calls</span>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="rounded-xl bg-surface-dark/50 px-4 py-6 text-center">
          <p className="text-sm text-muted">No routing decisions recorded</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {entries.map((entry, i) => (
            <BreakdownBadge key={i} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Compaction Events panel ──

function CompactionEventsPanel({
  violationCount,
  entries,
}: {
  violationCount: number;
  entries: BreakdownEntry[];
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MetricCard
          label="Preservation Violations"
          value={violationCount}
          variant={violationCount > 0 ? "error" : "success"}
        />
        <MetricCard
          label="Total Compaction Events"
          value={entries.reduce((s, e) => s + e.count, 0)}
          variant="default"
        />
      </div>

      {entries.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-muted">
            Event Breakdown
          </div>
          <div className="flex flex-wrap gap-2">
            {entries.map((entry, i) => (
              <BreakdownBadge key={i} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {violationCount === 0 && entries.length === 0 && (
        <div className="rounded-xl bg-surface-dark/50 px-4 py-6 text-center">
          <p className="text-sm text-muted">No compaction events recorded</p>
        </div>
      )}
    </div>
  );
}

// ── Live Logs panel ──

function stripAnsi(str: string): string {
  // Strip ANSI escape sequences (colors, bold, dim, etc.)
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function getToken(): string | null {
  return (
    localStorage.getItem(TOKEN_KEY) || localStorage.getItem(ADMIN_TOKEN_KEY)
  );
}

type LogLine = {
  id: number;
  text: string;
  level: "info" | "warn" | "error" | "debug" | "plain";
};

let logLineId = 0;

function classifyLine(text: string): LogLine["level"] {
  if (/ WARN /i.test(text) || /\bwarn\b/i.test(text)) return "warn";
  if (/ ERROR /i.test(text) || /\berror\b/i.test(text)) return "error";
  if (/ INFO /i.test(text) || /\binfo\b/i.test(text)) return "info";
  if (/ DEBUG /i.test(text) || /\bdebug\b/i.test(text)) return "debug";
  return "plain";
}

const LOG_LEVEL_COLOR: Record<LogLine["level"], string> = {
  info: "text-blue-400",
  warn: "text-yellow-400",
  error: "text-red-400",
  debug: "text-muted",
  plain: "text-text/80",
};

function LiveLogsPanel() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const lineBufferRef = useRef<LogLine[]>([]);

  const addLine = useCallback((text: string) => {
    const cleaned = stripAnsi(text).trim();
    if (!cleaned) return;
    const line: LogLine = {
      id: ++logLineId,
      text: cleaned,
      level: classifyLine(cleaned),
    };
    lineBufferRef.current = [...lineBufferRef.current, line].slice(-MAX_LOG_LINES);
    if (!pausedRef.current) {
      setLines([...lineBufferRef.current]);
    }
  }, []);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setError(null);

    const token = getToken();
    // EventSource doesn't support custom headers natively —
    // pass token as query param (same approach as the admin log viewer)
    const url = `${API_BASE}/api/my/profile/logs${token ? `?token=${encodeURIComponent(token)}` : ""}`;

    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch {
      setError("Log streaming requires server v0.2+");
      return;
    }
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (evt) => {
      addLine(evt.data);
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects; only surface an error if it never
      // connected at all
      if (lineBufferRef.current.length === 0) {
        setError("Unable to connect to log stream. The endpoint may not be available.");
      }
    };
  }, [addLine]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect]);

  // Auto-scroll to bottom when not paused
  useEffect(() => {
    if (!paused && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, paused]);

  const handlePauseToggle = () => {
    const next = !paused;
    setPaused(next);
    pausedRef.current = next;
    if (!next) {
      // Resume: flush buffered lines into state
      setLines([...lineBufferRef.current]);
    }
  };

  const handleClear = () => {
    lineBufferRef.current = [];
    setLines([]);
  };

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 rounded-full transition-colors ${connected ? "bg-green-400" : "bg-muted/40"}`}
          />
          <span className="text-xs text-muted">
            {connected ? "Connected" : "Connecting…"}
          </span>
        </div>
        <div className="flex-1" />
        <button
          onClick={handlePauseToggle}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted hover:text-text-strong hover:bg-surface-container transition"
        >
          {paused ? <Play size={12} /> : <Pause size={12} />}
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          onClick={handleClear}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted hover:text-text-strong hover:bg-surface-container transition"
        >
          <Trash2 size={12} />
          Clear
        </button>
      </div>

      {/* Log viewport */}
      <div className="relative h-72 overflow-y-auto rounded-xl bg-zinc-950 border border-border/20 p-3 font-mono text-[11px] leading-relaxed">
        {error && lines.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-yellow-400/80 text-xs text-center px-4">{error}</p>
          </div>
        ) : lines.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-muted/50">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-xs">Waiting for log events…</span>
            </div>
          </div>
        ) : (
          <>
            {lines.map((line) => (
              <div key={line.id} className={`${LOG_LEVEL_COLOR[line.level]} whitespace-pre-wrap break-all`}>
                {line.text}
              </div>
            ))}
            <div ref={bottomRef} />
          </>
        )}

        {/* Paused overlay */}
        {paused && lines.length > 0 && (
          <div className="pointer-events-none sticky bottom-0 left-0 right-0 flex justify-center pb-1">
            <span className="rounded-full bg-zinc-800/90 px-3 py-1 text-[10px] text-yellow-400 border border-yellow-400/20">
              Paused — {lineBufferRef.current.length} lines buffered
            </span>
          </div>
        )}
      </div>

      <div className="text-[10px] text-muted text-right">
        {lines.length}/{MAX_LOG_LINES} lines · SSE stream at{" "}
        <code className="font-mono">/api/my/profile/logs</code>
      </div>
    </div>
  );
}

// ── Main component ──

export function SystemTab() {
  const [summary, setSummary] = useState<OperatorSummary | null>(null);
  const [tasks, setTasks] = useState<OperatorTasksResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);

    try {
      const [s, t] = await Promise.all([
        fetchOperatorSummary(),
        fetchOperatorTasks(),
      ]);
      if (!s) {
        setError("Failed to fetch operator summary. The admin API may be unavailable.");
      }
      setSummary(s);
      setTasks(t);
    } catch {
      setError("Network error while fetching operator data.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => void load(true), AUTO_REFRESH_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="space-y-6">
        <div className="glass-section rounded-2xl p-6">
          <div className="flex flex-col items-center justify-center py-10">
            <AlertCircle size={32} className="mb-3 text-red-400/60" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => void load()}
              className="mt-4 flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm text-muted hover:text-text-strong hover:border-accent/30 transition"
            >
              <RefreshCw size={14} />
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const totals = summary?.totals ?? {};
  const breakdowns = summary?.breakdowns ?? {};
  const collection = summary?.collection;
  const sources = summary?.sources ?? [];

  const taskList = tasks?.tasks ?? [];
  const lifecycle = tasks?.totals_by_lifecycle ?? {};

  // Routing decision counts derived from breakdowns
  const routingEntries = breakdowns.routing_decisions ?? [];
  const cheapTotal = routingEntries
    .filter((e) => String(e.tier ?? e.model_tier ?? e.type ?? "") === "cheap")
    .reduce((s, e) => s + e.count, 0);
  const strongTotal = routingEntries
    .filter((e) => String(e.tier ?? e.model_tier ?? e.type ?? "") === "strong")
    .reduce((s, e) => s + e.count, 0);

  return (
    <div className="space-y-6">
      {/* Refresh bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-accent" />
          <span className="text-xs text-muted">
            Auto-refreshes every 30s
          </span>
        </div>
        <button
          onClick={() => void load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted hover:text-text-strong hover:bg-surface-container transition disabled:opacity-40"
        >
          <RefreshCw
            size={12}
            className={refreshing ? "animate-spin" : ""}
          />
          Refresh
        </button>
      </div>

      {/* Collection overview */}
      {collection && (
        <div className="glass-section rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <BarChart3 size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">
                Operator Overview
              </h3>
              <p className="text-xs text-muted">
                Gateway collection and aggregate metrics
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <MetricCard
              label="Running Gateways"
              value={collection.running_gateways}
              variant={
                collection.running_gateways > 0 ? "success" : "default"
              }
            />
            <MetricCard
              label="Sources Observed"
              value={collection.sources_observed}
            />
            <MetricCard
              label="Session Persists"
              value={totals.session_persists ?? 0}
            />
            <MetricCard
              label="Loop Errors"
              value={totals.loop_errors ?? 0}
              variant={
                (totals.loop_errors ?? 0) > 0 ? "error" : "default"
              }
            />
            <MetricCard
              label="Loop Retries"
              value={totals.loop_retries ?? 0}
              variant={
                (totals.loop_retries ?? 0) > 0 ? "warning" : "default"
              }
            />
            <MetricCard
              label="Routing Decisions"
              value={totals.routing_decisions ?? 0}
            />
            <MetricCard
              label="Credential Rotations"
              value={totals.credential_rotations ?? 0}
            />
            <MetricCard
              label="Compaction Violations"
              value={totals.compaction_preservation_violations ?? 0}
              variant={
                (totals.compaction_preservation_violations ?? 0) > 0
                  ? "error"
                  : "default"
              }
            />
            <MetricCard
              label="Validator Failures"
              value={totals.workspace_validator_required_failures ?? 0}
              variant={
                (totals.workspace_validator_required_failures ?? 0) > 0
                  ? "error"
                  : "default"
              }
            />
          </div>
        </div>
      )}

      {/* Error / Warning breakdowns */}
      {((breakdowns.loop_errors?.length ?? 0) > 0 ||
        (breakdowns.loop_retries?.length ?? 0) > 0) && (
        <div className="glass-section rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-400/10 text-red-400">
              <AlertTriangle size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">
                Errors & Retries
              </h3>
              <p className="text-xs text-muted">
                Breakdown of loop errors and retry decisions
              </p>
            </div>
          </div>

          {(breakdowns.loop_errors?.length ?? 0) > 0 && (
            <div className="mb-4">
              <div className="mb-2 text-xs font-medium text-red-400">
                Loop Errors
              </div>
              <div className="flex flex-wrap gap-2">
                {breakdowns.loop_errors.map((e, i) => (
                  <BreakdownBadge key={i} entry={e} />
                ))}
              </div>
            </div>
          )}

          {(breakdowns.loop_retries?.length ?? 0) > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-yellow-400">
                Loop Retries
              </div>
              <div className="flex flex-wrap gap-2">
                {breakdowns.loop_retries.map((e, i) => (
                  <BreakdownBadge key={i} entry={e} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── NEW: Retry Bucket State ── */}
      <CollapsibleSection
        icon={<GitBranch size={20} />}
        iconBg="bg-yellow-400/10"
        iconColor="text-yellow-400"
        title="Retry Bucket State"
        subtitle="Per-variant retry counters from loop retry events"
        defaultOpen={(breakdowns.loop_retries?.length ?? 0) > 0}
      >
        <RetryBucketPanel entries={breakdowns.loop_retries ?? []} />
      </CollapsibleSection>

      {/* ── NEW: Routing Decisions ── */}
      <CollapsibleSection
        icon={<Route size={20} />}
        iconBg="bg-accent/10"
        iconColor="text-accent"
        title="Routing Decisions"
        subtitle="Cheap vs strong LLM call share from routing decisions"
        defaultOpen={(totals.routing_decisions ?? 0) > 0}
      >
        <RoutingDecisionsPanel
          entries={routingEntries}
          cheapTotal={cheapTotal}
          strongTotal={strongTotal}
        />
      </CollapsibleSection>

      {/* ── NEW: Compaction Events ── */}
      <CollapsibleSection
        icon={<Package size={20} />}
        iconBg="bg-purple-400/10"
        iconColor="text-purple-400"
        title="Compaction Events"
        subtitle="Context compaction activity and preservation violations"
        defaultOpen={(totals.compaction_preservation_violations ?? 0) > 0}
      >
        <CompactionEventsPanel
          violationCount={totals.compaction_preservation_violations ?? 0}
          entries={breakdowns.compaction_preservation_violations ?? []}
        />
      </CollapsibleSection>

      {/* Gateway sources table */}
      {sources.length > 0 && (
        <div className="glass-section rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Activity size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">
                Gateway Sources
              </h3>
              <p className="text-xs text-muted">
                Per-source scrape status and sample counts
              </p>
            </div>
          </div>

          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border/30 text-xs text-muted">
                  <th className="px-2 pb-2 font-medium">Scope</th>
                  <th className="px-2 pb-2 font-medium">Status</th>
                  <th className="px-2 pb-2 font-medium text-right">
                    Samples
                  </th>
                  <th className="px-2 pb-2 font-medium text-right">
                    Sessions
                  </th>
                  <th className="px-2 pb-2 font-medium text-right">
                    Errors
                  </th>
                </tr>
              </thead>
              <tbody>
                {sources.map((src, idx) => (
                  <tr
                    key={idx}
                    className="border-b border-border/10 last:border-0"
                  >
                    <td className="px-2 py-2.5 font-mono text-xs text-text-strong">
                      {src.scope}
                    </td>
                    <td className="px-2 py-2.5">
                      <span className="flex items-center gap-1.5 text-xs">
                        {src.available ? (
                          <CheckCircle size={12} className="text-green-400" />
                        ) : (
                          <AlertCircle size={12} className="text-red-400" />
                        )}
                        <span className="text-muted">
                          {src.scrape_status}
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-xs text-text">
                      {src.sample_count}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-xs text-text">
                      {src.totals.session_persists ?? 0}
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-xs">
                      <span
                        className={
                          (src.totals.loop_errors ?? 0) > 0
                            ? "text-red-400"
                            : "text-muted"
                        }
                      >
                        {src.totals.loop_errors ?? 0}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Operator tasks */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ListChecks size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">
                Operator Tasks
              </h3>
              <p className="text-xs text-muted">
                Background task queue status
              </p>
            </div>
          </div>
        </div>

        {/* Lifecycle counters */}
        <div className="mb-4 flex flex-wrap gap-3">
          {Object.entries(lifecycle).map(([status, count]) => (
            <MetricCard
              key={status}
              label={status}
              value={count as number}
              variant={
                status === "failed" && (count as number) > 0
                  ? "error"
                  : status === "running"
                    ? "success"
                    : "default"
              }
            />
          ))}
          {tasks && (
            <>
              {tasks.stale_count > 0 && (
                <MetricCard
                  label="Stale"
                  value={tasks.stale_count}
                  variant="warning"
                />
              )}
              {tasks.missing_artifact_count > 0 && (
                <MetricCard
                  label="Missing Artifacts"
                  value={tasks.missing_artifact_count}
                  variant="error"
                />
              )}
              {tasks.validator_failed_count > 0 && (
                <MetricCard
                  label="Validator Failed"
                  value={tasks.validator_failed_count}
                  variant="error"
                />
              )}
            </>
          )}
        </div>

        {taskList.length === 0 ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-8 text-center">
            <ListChecks size={28} className="mx-auto mb-2 text-muted/40" />
            <p className="text-sm text-muted">No tasks in queue</p>
          </div>
        ) : (
          <div className="space-y-2">
            {taskList.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-4 rounded-xl bg-surface-container/60 px-4 py-3 border border-transparent hover:border-border transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-strong truncate font-mono">
                      {task.tool_name}
                    </span>
                    <TaskStatusBadge status={task.status} />
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted truncate">
                    {task.id}
                    {task.started_at && ` \u00b7 ${new Date(task.started_at).toLocaleTimeString()}`}
                  </div>
                </div>
                {task.error && (
                  <span className="shrink-0 text-xs text-red-400 truncate max-w-48">
                    {task.error}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── NEW: Live Logs ── */}
      <CollapsibleSection
        icon={<Terminal size={20} />}
        iconBg="bg-zinc-400/10"
        iconColor="text-zinc-300"
        title="Live Logs"
        subtitle="Real-time gateway log stream via SSE"
        defaultOpen={false}
      >
        <LiveLogsPanel />
      </CollapsibleSection>
    </div>
  );
}
