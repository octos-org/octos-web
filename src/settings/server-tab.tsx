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
  Shield,
  Activity,
  Copy,
  Check,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  fetchAllProfiles,
  startProfile,
  stopProfile,
  type Profile,
} from "./settings-api";
import { request } from "@/api/client";

// ── Types ────────────────────────────────────────────────────────────────────

type DeploymentMode = "standalone" | "local" | "cloud" | "tenant";

interface AdminSettings {
  watchdog_enabled: boolean;
  proactive_alerts: boolean;
  deployment_mode: DeploymentMode;
}

interface ServerResources {
  memory_used_mb: number;
  memory_total_mb: number;
  cpu_percent: number;
  uptime_secs: number;
  version: string;
}

interface RotateTokenResponse {
  token: string;
}

// ── API helpers (TODO: implement these endpoints server-side) ─────────────────

async function fetchAdminSettings(): Promise<AdminSettings | null> {
  // TODO: implement GET /api/admin/settings on the server
  try {
    return await request<AdminSettings>("/api/admin/settings");
  } catch {
    // Return safe defaults when endpoint is not yet available
    return {
      watchdog_enabled: false,
      proactive_alerts: false,
      deployment_mode: "standalone",
    };
  }
}

async function patchAdminSettings(
  patch: Partial<AdminSettings>,
): Promise<boolean> {
  // TODO: implement PATCH /api/admin/settings on the server
  try {
    await request<AdminSettings>("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return true;
  } catch {
    return false;
  }
}

async function fetchServerResources(): Promise<ServerResources | null> {
  // TODO: implement GET /api/admin/server on the server
  try {
    return await request<ServerResources>("/api/admin/server");
  } catch {
    return null;
  }
}

async function rotateAdminToken(): Promise<string | null> {
  // TODO: implement POST /api/admin/token/rotate on the server
  try {
    const resp = await request<RotateTokenResponse>(
      "/api/admin/token/rotate",
      { method: "POST" },
    );
    return resp.token ?? null;
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUptime(secs: number | null): string {
  if (secs == null) return "\u2014";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function maskToken(token: string): string {
  if (token.length <= 8) return "••••••••";
  return token.slice(0, 4) + "••••••••••••••••" + token.slice(-4);
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-border"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ServerTab() {
  // Profiles state
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: "start-all" | "stop-all";
  } | null>(null);

  // Admin settings state
  const [adminSettings, setAdminSettings] = useState<AdminSettings>({
    watchdog_enabled: false,
    proactive_alerts: false,
    deployment_mode: "standalone",
  });
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Server resources state
  const [resources, setResources] = useState<ServerResources | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(true);

  // Token rotation state
  const [tokenMasked, setTokenMasked] = useState(true);
  const [currentToken] = useState("mofamofa"); // placeholder; real value comes from auth context
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const data = await fetchAllProfiles();
    setProfiles(data);
    setLoading(false);
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  // Load admin settings
  useEffect(() => {
    void (async () => {
      const s = await fetchAdminSettings();
      if (s) setAdminSettings(s);
    })();
  }, []);

  // Load server resources
  useEffect(() => {
    void (async () => {
      setResourcesLoading(true);
      const r = await fetchServerResources();
      setResources(r);
      setResourcesLoading(false);
    })();
  }, []);

  // Handlers: profiles
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

  // Handlers: admin settings
  const updateSetting = async (patch: Partial<AdminSettings>) => {
    const next = { ...adminSettings, ...patch };
    setAdminSettings(next);
    setSettingsSaving(true);
    await patchAdminSettings(patch);
    setSettingsSaving(false);
  };

  // Handlers: token rotation
  const handleRotate = async () => {
    setConfirmRotate(false);
    setRotating(true);
    const token = await rotateAdminToken();
    setNewToken(token);
    setRotating(false);
  };

  const handleCopyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      // clipboard not available
    }
  };

  const runningCount = profiles.filter((p) => p.status.running).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-muted" />
      </div>
    );
  }

  const deploymentModes: { value: DeploymentMode; label: string; description: string }[] = [
    { value: "standalone", label: "Standalone", description: "Single-node, all services on one machine" },
    { value: "local", label: "Local", description: "Local network deployment" },
    { value: "cloud", label: "Cloud", description: "Cloud-hosted with managed infrastructure" },
    { value: "tenant", label: "Tenant", description: "Multi-tenant with isolated namespaces" },
  ];

  return (
    <div className="space-y-6">
      {/* ── Server Info card ─────────────────────────────────────────── */}
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

      {/* ── Server Resources panel ────────────────────────────────────── */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Activity size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">
                Server Resources
              </h3>
              <p className="text-xs text-muted">
                Memory, CPU, uptime and version
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              setResourcesLoading(true);
              void fetchServerResources().then((r) => {
                setResources(r);
                setResourcesLoading(false);
              });
            }}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-muted hover:text-text-strong hover:bg-surface-container transition"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>

        {resourcesLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={18} className="animate-spin text-muted" />
          </div>
        ) : resources ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {/* Memory */}
            <div className="rounded-xl border border-border/30 px-4 py-3">
              <div className="text-lg font-bold tabular-nums text-text-strong">
                {Math.round(resources.memory_used_mb / 10.24) / 100}
                <span className="text-xs font-normal text-muted ml-1">GB</span>
              </div>
              <div className="mt-0.5 text-xs text-muted">
                Memory Used
              </div>
              {resources.memory_total_mb > 0 && (
                <div className="mt-1.5 h-1 w-full rounded-full bg-border/40 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{
                      width: `${Math.min(100, (resources.memory_used_mb / resources.memory_total_mb) * 100)}%`,
                    }}
                  />
                </div>
              )}
            </div>
            {/* CPU */}
            <div className="rounded-xl border border-border/30 px-4 py-3">
              <div className="text-lg font-bold tabular-nums text-text-strong">
                {resources.cpu_percent.toFixed(1)}
                <span className="text-xs font-normal text-muted ml-1">%</span>
              </div>
              <div className="mt-0.5 text-xs text-muted">CPU Usage</div>
              <div className="mt-1.5 h-1 w-full rounded-full bg-border/40 overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${Math.min(100, resources.cpu_percent)}%` }}
                />
              </div>
            </div>
            {/* Uptime */}
            <div className="rounded-xl border border-border/30 px-4 py-3">
              <div className="text-lg font-bold tabular-nums text-text-strong">
                {formatUptime(resources.uptime_secs)}
              </div>
              <div className="mt-0.5 text-xs text-muted">Server Uptime</div>
            </div>
            {/* Version */}
            <div className="rounded-xl border border-border/30 px-4 py-3">
              <div className="text-lg font-bold tabular-nums text-text-strong font-mono">
                {resources.version || "—"}
              </div>
              <div className="mt-0.5 text-xs text-muted">Octos Version</div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-8 text-center">
            <Activity size={28} className="mx-auto mb-2 text-muted/40" />
            <p className="text-xs text-muted">
              Resource metrics unavailable
            </p>
            <p className="mt-0.5 text-[10px] text-muted/60">
              {/* TODO: server-side: implement GET /api/admin/server returning memory_used_mb, memory_total_mb, cpu_percent, uptime_secs, version */}
              Endpoint not yet available — implement{" "}
              <code className="font-mono">GET /api/admin/server</code>
            </p>
          </div>
        )}
      </div>

      {/* ── Reliability (Watchdog + Alerts) ──────────────────────────── */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <RefreshCw size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              Reliability
            </h3>
            <p className="text-xs text-muted">
              Automatic recovery and alerting
              {settingsSaving && (
                <span className="ml-2 text-accent">Saving…</span>
              )}
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {/* Watchdog toggle */}
          <div className="flex items-center justify-between rounded-xl bg-surface-container/60 border border-transparent hover:border-border/40 px-4 py-3.5 transition">
            <div>
              <div className="text-sm font-medium text-text-strong">
                Automatically restart crashed gateways
              </div>
              <div className="mt-0.5 text-xs text-muted">
                Watchdog monitors each gateway and restarts it if it exits unexpectedly
              </div>
            </div>
            <ToggleSwitch
              checked={adminSettings.watchdog_enabled}
              disabled={settingsSaving}
              onChange={(v) => void updateSetting({ watchdog_enabled: v })}
            />
          </div>

          {/* Proactive alerts toggle */}
          <div className="flex items-center justify-between rounded-xl bg-surface-container/60 border border-transparent hover:border-border/40 px-4 py-3.5 transition">
            <div>
              <div className="text-sm font-medium text-text-strong">
                Send proactive alerts when gateways crash
              </div>
              <div className="mt-0.5 text-xs text-muted">
                Notify configured channels (email, webhook) on gateway failures
              </div>
            </div>
            <ToggleSwitch
              checked={adminSettings.proactive_alerts}
              disabled={settingsSaving}
              onChange={(v) => void updateSetting({ proactive_alerts: v })}
            />
          </div>
        </div>

        <p className="mt-3 text-[10px] text-muted/50">
          {/* TODO: server-side: implement PATCH /api/admin/settings accepting { watchdog_enabled, proactive_alerts } */}
          Settings are persisted via{" "}
          <code className="font-mono">PATCH /api/admin/settings</code> (stub
          returns defaults until server-side implementation is complete).
        </p>
      </div>

      {/* ── Deployment Mode selector ──────────────────────────────────── */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Server size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              Deployment Mode
            </h3>
            <p className="text-xs text-muted">
              Select how this server is deployed
              {settingsSaving && (
                <span className="ml-2 text-accent">Saving…</span>
              )}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          {deploymentModes.map((mode) => (
            <label
              key={mode.value}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3.5 transition ${
                adminSettings.deployment_mode === mode.value
                  ? "border-accent/40 bg-accent/5"
                  : "border-transparent bg-surface-container/60 hover:border-border/40"
              }`}
            >
              <input
                type="radio"
                name="deployment_mode"
                value={mode.value}
                checked={adminSettings.deployment_mode === mode.value}
                disabled={settingsSaving}
                onChange={() =>
                  void updateSetting({ deployment_mode: mode.value })
                }
                className="mt-0.5 accent-accent"
              />
              <div>
                <div className="text-sm font-medium text-text-strong">
                  {mode.label}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {mode.description}
                </div>
              </div>
            </label>
          ))}
        </div>

        <p className="mt-3 text-[10px] text-muted/50">
          {/* TODO: server-side: expose detected deployment mode via GET /api/admin/settings and accept PATCH */}
          Mode is saved via{" "}
          <code className="font-mono">PATCH /api/admin/settings</code>. Detected
          mode is read from{" "}
          <code className="font-mono">GET /api/admin/settings</code>.
        </p>
      </div>

      {/* ── Security: Rotate Admin Token ──────────────────────────────── */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Shield size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              Security
            </h3>
            <p className="text-xs text-muted">Admin token management</p>
          </div>
        </div>

        {/* Current token row */}
        <div className="rounded-xl bg-surface-container/60 border border-border/30 px-4 py-3.5 mb-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-muted mb-1">Current Admin Token</div>
              <div className="font-mono text-sm text-text-strong truncate">
                {tokenMasked ? maskToken(currentToken) : currentToken}
              </div>
            </div>
            <button
              onClick={() => setTokenMasked((v) => !v)}
              className="shrink-0 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted hover:text-text-strong hover:bg-surface-dark/40 transition"
              aria-label={tokenMasked ? "Show token" : "Hide token"}
            >
              {tokenMasked ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          </div>
        </div>

        {/* New token display (shown after rotation) */}
        {newToken && (
          <div className="mb-3 rounded-xl border border-green-400/30 bg-green-400/5 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 mb-1">
                  <CheckCircle size={12} className="shrink-0 text-green-400" />
                  <span className="text-xs font-medium text-green-400">
                    New token — copy it now, it won't be shown again
                  </span>
                </div>
                <div className="font-mono text-sm text-text-strong break-all">
                  {newToken}
                </div>
              </div>
              <button
                onClick={() => void handleCopyToken(newToken)}
                className="shrink-0 flex items-center gap-1.5 rounded-lg bg-green-500/15 px-2.5 py-1.5 text-xs font-medium text-green-400 hover:bg-green-500/25 transition"
              >
                {tokenCopied ? (
                  <Check size={12} />
                ) : (
                  <Copy size={12} />
                )}
                {tokenCopied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {/* Confirm rotation dialog */}
        {confirmRotate && (
          <div className="mb-3 flex items-center gap-3 rounded-xl border border-yellow-400/30 bg-yellow-400/5 px-4 py-3">
            <AlertCircle size={16} className="shrink-0 text-yellow-400" />
            <span className="flex-1 text-xs text-yellow-400">
              Rotate the admin token? The current token will be invalidated
              immediately.
            </span>
            <button
              onClick={() => void handleRotate()}
              className="rounded-lg bg-yellow-400/20 px-3 py-1 text-xs font-medium text-yellow-400 hover:bg-yellow-400/30 transition"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmRotate(false)}
              className="rounded-lg px-3 py-1 text-xs text-muted hover:text-text-strong transition"
            >
              Cancel
            </button>
          </div>
        )}

        <button
          onClick={() => {
            setNewToken(null);
            setConfirmRotate(true);
          }}
          disabled={rotating || confirmRotate}
          className="flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-500/5 px-4 py-2.5 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition"
        >
          {rotating ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Shield size={13} />
          )}
          Generate New Token
        </button>

        <p className="mt-3 text-[10px] text-muted/50">
          {/* TODO: server-side: implement POST /api/admin/token/rotate returning { token: string } */}
          Token rotation calls{" "}
          <code className="font-mono">POST /api/admin/token/rotate</code>. The
          new token is shown exactly once.
        </p>
      </div>

      {/* ── Profiles management ───────────────────────────────────────── */}
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
                          <span>PID {p.status.pid}</span>
                          <span>Uptime {formatUptime(p.status.uptime_secs)}</span>
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
