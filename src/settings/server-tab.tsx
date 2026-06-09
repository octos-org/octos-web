import { useState, useEffect, useCallback } from "react";
import {
  Server,
  Play,
  Square,
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle,
  Users,
} from "lucide-react";
import {
  fetchAllProfiles,
  startProfile,
  stopProfile,
  type Profile,
} from "./settings-api";

function formatUptime(secs: number | null): string {
  if (secs == null) return "\u2014";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function ServerTab() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: "start-all" | "stop-all";
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const data = await fetchAllProfiles();
    if (data.length === 0 && !error) {
      // Could be empty or a fetch failure; fetchAllProfiles returns []
      // on error. We accept this gracefully.
    }
    setProfiles(data);
    setLoading(false);
  }, [error]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleStart = async (id: string) => {
    setActionInFlight(id);
    setActionError(null);
    const err = await startProfile(id);
    if (err) setActionError(`Start "${id}": ${err}`);
    await load();
    setActionInFlight(null);
  };

  const handleStop = async (id: string) => {
    setActionInFlight(id);
    setActionError(null);
    const err = await stopProfile(id);
    if (err) setActionError(`Stop "${id}": ${err}`);
    await load();
    setActionInFlight(null);
  };

  const handleBulk = async (action: "start" | "stop") => {
    setConfirmAction(null);
    setActionError(null);

    for (const p of profiles) {
      setActionInFlight(p.id);
      if (action === "start" && !p.status.running) {
        const err = await startProfile(p.id);
        if (err) {
          setActionError(`Start "${p.id}": ${err}`);
          break;
        }
      } else if (action === "stop" && p.status.running) {
        const err = await stopProfile(p.id);
        if (err) {
          setActionError(`Stop "${p.id}": ${err}`);
          break;
        }
      }
    }

    await load();
    setActionInFlight(null);
  };

  const runningCount = profiles.filter((p) => p.status.running).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Server info card */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Server size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              Server Info
            </h3>
            <p className="text-xs text-muted">
              Runtime environment overview
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border/30 px-4 py-3">
            <div className="text-2xl font-bold tabular-nums text-text-strong">
              {profiles.length}
            </div>
            <div className="mt-0.5 text-xs text-muted">Total Profiles</div>
          </div>
          <div
            className={`rounded-xl border px-4 py-3 ${runningCount > 0 ? "border-green-400/30 bg-green-400/5" : "border-border/30"}`}
          >
            <div
              className={`text-2xl font-bold tabular-nums ${runningCount > 0 ? "text-green-400" : "text-text-strong"}`}
            >
              {runningCount}
            </div>
            <div className="mt-0.5 text-xs text-muted">Running</div>
          </div>
          <div className="rounded-xl border border-border/30 px-4 py-3">
            <div className="text-2xl font-bold tabular-nums text-text-strong">
              {profiles.length - runningCount}
            </div>
            <div className="mt-0.5 text-xs text-muted">Stopped</div>
          </div>
        </div>
      </div>

      {/* Profiles management */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Users size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">
                All Profiles
              </h3>
              <p className="text-xs text-muted">
                {profiles.length} profile{profiles.length !== 1 ? "s" : ""}{" "}
                registered
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted hover:text-text-strong hover:bg-surface-container transition"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
            <button
              onClick={() => setConfirmAction({ type: "start-all" })}
              disabled={actionInFlight !== null}
              className="flex items-center gap-1.5 rounded-lg bg-green-500/15 px-3 py-1.5 text-xs font-medium text-green-400 hover:bg-green-500/25 disabled:opacity-40 transition"
            >
              <Play size={12} />
              Start All
            </button>
            <button
              onClick={() => setConfirmAction({ type: "stop-all" })}
              disabled={actionInFlight !== null}
              className="flex items-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/25 disabled:opacity-40 transition"
            >
              <Square size={10} />
              Stop All
            </button>
          </div>
        </div>

        {/* Confirmation dialog */}
        {confirmAction && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-yellow-400/30 bg-yellow-400/5 px-4 py-3">
            <AlertCircle size={16} className="shrink-0 text-yellow-400" />
            <span className="flex-1 text-xs text-yellow-400">
              {confirmAction.type === "start-all"
                ? "Start all stopped gateways?"
                : "Stop all running gateways?"}
            </span>
            <button
              onClick={() =>
                void handleBulk(
                  confirmAction.type === "start-all" ? "start" : "stop",
                )
              }
              className="rounded-lg bg-yellow-400/20 px-3 py-1 text-xs font-medium text-yellow-400 hover:bg-yellow-400/30 transition"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmAction(null)}
              className="rounded-lg px-3 py-1 text-xs text-muted hover:text-text-strong transition"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Action error */}
        {actionError && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3">
            <AlertCircle size={14} className="shrink-0 text-red-400" />
            <span className="text-xs text-red-400">{actionError}</span>
          </div>
        )}

        {/* Fetch error */}
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3">
            <AlertCircle size={14} className="shrink-0 text-red-400" />
            <span className="text-xs text-red-400">{error}</span>
          </div>
        )}

        {profiles.length === 0 ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-10 text-center">
            <Users size={32} className="mx-auto mb-3 text-muted/40" />
            <p className="text-sm text-muted">No profiles found</p>
            <p className="mt-1 text-xs text-muted/60">
              Profiles may not be accessible with current credentials
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((p) => {
              const isInFlight = actionInFlight === p.id;
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-4 rounded-xl bg-surface-container/60 px-4 py-3.5 border border-transparent hover:border-border transition"
                >
                  {/* Status dot */}
                  <div className="shrink-0">
                    {p.status.running ? (
                      <CheckCircle size={16} className="text-green-400" />
                    ) : (
                      <div className="h-4 w-4 rounded-full border-2 border-muted/30" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-strong truncate">
                        {p.name || p.id}
                      </span>
                      {p.name && p.name !== p.id && (
                        <span className="shrink-0 rounded-md bg-surface-dark/60 px-1.5 py-0.5 text-[10px] font-medium text-muted font-mono">
                          {p.id}
                        </span>
                      )}
                      {!p.enabled && (
                        <span className="shrink-0 rounded-md bg-yellow-400/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-400">
                          disabled
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted">
                      {p.status.running ? (
                        <>
                          <span>
                            PID {p.status.pid}
                          </span>
                          <span>
                            Uptime {formatUptime(p.status.uptime_secs)}
                          </span>
                        </>
                      ) : (
                        <span>Stopped</span>
                      )}
                      {p.config?.llm?.primary?.model_id && (
                        <span className="font-mono">
                          {p.config.llm.primary.family_id}/{p.config.llm.primary.model_id}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="shrink-0 flex items-center gap-2">
                    {p.status.running ? (
                      <button
                        onClick={() => void handleStop(p.id)}
                        disabled={isInFlight}
                        className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/20 disabled:opacity-40 transition"
                      >
                        {isInFlight ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Square size={10} />
                        )}
                        Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => void handleStart(p.id)}
                        disabled={isInFlight}
                        className="flex items-center gap-1.5 rounded-lg bg-green-500/10 px-3 py-1.5 text-xs font-medium text-green-400 hover:bg-green-500/20 disabled:opacity-40 transition"
                      >
                        {isInFlight ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Play size={12} />
                        )}
                        Start
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
