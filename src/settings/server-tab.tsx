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
} from "lucide-react";
import {
  fetchAllProfiles,
  formatSettingsError,
  startProfile,
  stopProfile,
  type Profile,
} from "./settings-api";
import { request } from "@/api/client";

// ── Types ────────────────────────────────────────────────────────────────────

type DeploymentMode = "local" | "cloud" | "tenant";

interface AdminSettings {
  watchdog_enabled: boolean;
  proactive_alerts: boolean;
  deployment_mode: DeploymentMode;
  deployment_explicit: boolean;
  deployment_detected: DeploymentMode | null;
}

interface ServerResources {
  memory_used_mb: number;
  memory_total_mb: number;
  cpu_percent: number;
  uptime_secs: number;
  version: string;
}

interface MonitorStatusResponse {
  watchdog_enabled: boolean;
  alerts_enabled: boolean;
}

interface DeploymentModeResponse {
  mode: string;
  explicit?: boolean;
}

interface DeploymentModeDetectionResponse {
  detected: string;
}

interface TokenStatusResponse {
  rotated: boolean;
}

interface SystemMetricsResponse {
  cpu?: {
    usage_percent?: number;
  };
  memory?: {
    total_bytes?: number;
    used_bytes?: number;
  };
  platform?: {
    uptime_secs?: number;
  };
}

interface HealthResponse {
  version?: string;
}

// ── API helpers ──────────────────────────────────────────────────────────────

function asDeploymentMode(value: string | null | undefined): DeploymentMode {
  if (value === "tenant" || value === "cloud") return value;
  return "local";
}

async function fetchAdminSettings(): Promise<AdminSettings | null> {
  try {
    const [monitor, deployment, detected] = await Promise.all([
      request<MonitorStatusResponse>("/api/admin/monitor/status"),
      request<DeploymentModeResponse>("/api/admin/deployment-mode"),
      request<DeploymentModeDetectionResponse>("/api/admin/deployment-mode/detect"),
    ]);
    return {
      watchdog_enabled: Boolean(monitor.watchdog_enabled),
      proactive_alerts: Boolean(monitor.alerts_enabled),
      deployment_mode: asDeploymentMode(deployment.mode),
      deployment_explicit: Boolean(deployment.explicit),
      deployment_detected: asDeploymentMode(detected.detected),
    };
  } catch {
    return null;
  }
}

async function patchAdminSettings(
  patch: Partial<AdminSettings>,
): Promise<boolean> {
  try {
    if (patch.watchdog_enabled !== undefined) {
      await request<{ ok: boolean; watchdog_enabled: boolean }>(
        "/api/admin/monitor/watchdog",
        {
          method: "POST",
          body: JSON.stringify({ enabled: patch.watchdog_enabled }),
        },
      );
    }
    if (patch.proactive_alerts !== undefined) {
      await request<{ ok: boolean; alerts_enabled: boolean }>(
        "/api/admin/monitor/alerts",
        {
          method: "POST",
          body: JSON.stringify({ enabled: patch.proactive_alerts }),
        },
      );
    }
    if (patch.deployment_mode !== undefined) {
      await request<void>("/api/admin/deployment-mode", {
        method: "POST",
        body: JSON.stringify({ mode: patch.deployment_mode }),
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchServerResources(): Promise<ServerResources | null> {
  try {
    const [metrics, health] = await Promise.all([
      request<SystemMetricsResponse>("/api/admin/system/metrics"),
      request<HealthResponse>("/health").catch((): HealthResponse => ({})),
    ]);
    return {
      memory_used_mb: Math.round((metrics.memory?.used_bytes ?? 0) / 1024 / 1024),
      memory_total_mb: Math.round((metrics.memory?.total_bytes ?? 0) / 1024 / 1024),
      cpu_percent: metrics.cpu?.usage_percent ?? 0,
      uptime_secs: metrics.platform?.uptime_secs ?? 0,
      version: health.version ?? "unknown",
    };
  } catch {
    return null;
  }
}

async function fetchTokenStatus(): Promise<TokenStatusResponse | null> {
  try {
    return await request<TokenStatusResponse>("/api/admin/token/status");
  } catch {
    return null;
  }
}

async function rotateAdminToken(newToken: string): Promise<boolean> {
  try {
    await request<void>("/api/admin/token/rotate", {
      method: "POST",
      body: JSON.stringify({ new_token: newToken }),
    });
    return true;
  } catch {
    return false;
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
    deployment_mode: "local",
    deployment_explicit: false,
    deployment_detected: null,
  });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Server resources state
  const [resources, setResources] = useState<ServerResources | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(true);

  // Token rotation state
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [tokenRotated, setTokenRotated] = useState<boolean | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenMessage, setTokenMessage] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchAllProfiles();
      setProfiles(data);
    } catch (err) {
      setError(formatSettingsError(err, "Failed to load profiles."));
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // Load admin settings
  useEffect(() => {
    void (async () => {
      const s = await fetchAdminSettings();
      if (s) setAdminSettings(s);
      else setSettingsError("Admin monitor/deployment settings are unavailable.");
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

  useEffect(() => {
    void fetchTokenStatus().then((status) => {
      if (status) setTokenRotated(status.rotated);
    });
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
    const previous = adminSettings;
    const next = { ...adminSettings, ...patch };
    setAdminSettings(next);
    setSettingsSaving(true);
    setSettingsError(null);
    const ok = await patchAdminSettings(patch);
    if (!ok) {
      setAdminSettings(previous);
      setSettingsError("Failed to save admin setting.");
    }
    setSettingsSaving(false);
  };

  // Handlers: token rotation
  const handleRotate = async () => {
    const value = tokenInput;
    if (value.trim() !== value) {
      setTokenError("Token must not have leading or trailing whitespace.");
      return;
    }
    if (value.length < 8) {
      setTokenError("Token must be at least 8 characters.");
      return;
    }
    setConfirmRotate(false);
    setRotating(true);
    setTokenError(null);
    setTokenMessage(null);
    const ok = await rotateAdminToken(value);
    if (ok) {
      setTokenRotated(true);
      setTokenInput("");
      setTokenMessage("Admin token rotated. Use the new token for future admin-token login.");
    } else {
      setTokenError("Failed to rotate token. It may already be rotated or the token was rejected.");
    }
    setRotating(false);
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
    { value: "local", label: "Local", description: "Single-node or LAN-only deployment" },
    { value: "cloud", label: "Cloud", description: "Cloud-hosted with managed infrastructure" },
    { value: "tenant", label: "Tenant", description: "Multi-tenant with isolated namespaces" },
  ];

  return (
    <div className="space-y-6">
      {/* ── Server Info card ─────────────────────────────────────────── */}
      <div className="glass-section rounded-lg p-6">
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
      <div className="glass-section rounded-lg p-6">
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
              Could not read <code className="font-mono">GET /api/admin/system/metrics</code>
            </p>
          </div>
        )}
      </div>

      {/* ── Reliability (Watchdog + Alerts) ──────────────────────────── */}
      <div className="glass-section rounded-lg p-6">
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
          {settingsError && (
            <div className="rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3 text-xs text-red-300">
              {settingsError}
            </div>
          )}
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
          Settings use <code className="font-mono">/api/admin/monitor/status</code>,{" "}
          <code className="font-mono">/watchdog</code>, and{" "}
          <code className="font-mono">/alerts</code>.
        </p>
      </div>

      {/* ── Deployment Mode selector ──────────────────────────────────── */}
      <div className="glass-section rounded-lg p-6">
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
              {adminSettings.deployment_detected && (
                <span className="ml-2 text-muted/70">
                  Detected: {adminSettings.deployment_detected}
                </span>
              )}
              {!adminSettings.deployment_explicit && (
                <span className="ml-2 text-yellow-400">Using default</span>
              )}
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
          Mode is read from <code className="font-mono">GET /api/admin/deployment-mode</code> and saved via{" "}
          <code className="font-mono">POST /api/admin/deployment-mode</code>.
        </p>
      </div>

      {/* ── Security: Rotate Admin Token ──────────────────────────────── */}
      <div className="glass-section rounded-lg p-6">
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
            <div>
              <div className="text-xs text-muted mb-1">Admin Token Status</div>
              <div className="text-sm text-text-strong">
                {tokenRotated === null
                  ? "Unknown"
                  : tokenRotated
                    ? "Rotated token is active"
                    : "Bootstrap token has not been rotated"}
              </div>
            </div>
            {tokenRotated !== null && (
              <span
                className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  tokenRotated
                    ? "bg-green-400/15 text-green-400"
                    : "bg-yellow-400/15 text-yellow-400"
                }`}
              >
                {tokenRotated ? "Rotated" : "Bootstrap"}
              </span>
            )}
          </div>
        </div>

        {tokenMessage && (
          <div className="mb-3 rounded-xl border border-green-400/30 bg-green-400/5 px-4 py-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-green-400">
              <CheckCircle size={12} className="shrink-0" />
              {tokenMessage}
            </div>
          </div>
        )}

        {tokenError && (
          <div className="mb-3 rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3 text-xs text-red-300">
            {tokenError}
          </div>
        )}

        <input
          type="password"
          value={tokenInput}
          onChange={(e) => {
            setTokenInput(e.target.value);
            setTokenError(null);
          }}
          placeholder="New admin token, minimum 8 characters"
          autoComplete="new-password"
          className="mb-3 w-full rounded-xl border border-transparent bg-surface-container px-4 py-3 font-mono text-sm text-text outline-none transition placeholder:text-muted/50 focus:border-accent/30"
        />

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
            setTokenMessage(null);
            setConfirmRotate(true);
          }}
          disabled={rotating || confirmRotate || tokenInput.length === 0}
          className="flex items-center gap-2 rounded-xl border border-red-400/20 bg-red-500/5 px-4 py-2.5 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition"
        >
          {rotating ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Shield size={13} />
          )}
          Rotate Token
        </button>

        <p className="mt-3 text-[10px] text-muted/50">
          Token rotation sends your chosen value to{" "}
          <code className="font-mono">POST /api/admin/token/rotate</code>; the server returns{" "}
          <code className="font-mono">204</code> on success.
        </p>
      </div>

      {/* ── Profiles management ───────────────────────────────────────── */}
      <div className="glass-section rounded-lg p-6">
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
