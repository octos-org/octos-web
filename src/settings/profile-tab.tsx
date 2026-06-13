import { useState, useCallback } from "react";
import {
  User,
  Save,
  Loader2,
  Check,
  Activity,
  Play,
  Square,
  RotateCcw,
  Plus,
  Pencil,
  Trash2,
  KeyRound,
  AlertTriangle,
} from "lucide-react";
import {
  updateMyProfile,
  formatSettingsError,
  getMyProfile,
  startMyGateway,
  stopMyGateway,
  restartMyGateway,
  deleteAdminProfile,
  type Profile,
} from "./settings-api";
import { ConfirmDialog } from "./confirm-dialog";

// ── Labels (no hardcoded user-visible strings in JSX) ──

const LABELS = {
  profileInfo: "Profile Information",
  profileInfoDesc: "Manage your profile details",
  profileId: "Profile ID",
  displayName: "Display Name",
  displayNamePlaceholder: "Enter display name",
  autoStart: "Auto-start Gateway",
  autoStartDesc: "Automatically start gateway when server starts",
  adminMode: "Admin Mode",
  adminModeDesc: "Admin-only tools, restricted shell/file/web access",
  created: "Created",
  saveChanges: "Save Changes",
  saved: "Saved",
  saveFailed: "Failed to update profile.",

  gatewayStatus: "Gateway Status",
  gatewayStatusDesc: "Runtime status of the gateway process",
  status: "Status",
  running: "Running",
  stopped: "Stopped",
  pid: "PID",
  uptime: "Uptime",
  start: "Start",
  stop: "Stop",
  restart: "Restart",

  stopTitle: "Stop Gateway",
  stopBody:
    "Are you sure you want to stop the gateway? Active sessions will be interrupted.",
  stopConfirm: "Stop Gateway",

  restartTitle: "Restart Gateway",
  restartBody:
    "Are you sure you want to restart the gateway? Active sessions will be briefly interrupted.",
  restartConfirm: "Restart Gateway",

  envVars: "Environment Variables",
  envVarsDesc: "Secret keys and configuration values",
  noEnvVars: "No environment variables configured",
  addVariable: "Add Variable",
  keyPlaceholder: "VARIABLE_NAME",
  valuePlaceholder: "Enter value",
  valueMaskedPlaceholder: "Enter new value (leave empty to keep current)",
  saveEnvVars: "Save Variables",
  envSaved: "Saved",
  envSaveFailed: "Failed to save environment variables.",
  deleteVarTitle: "Delete Variable",
  deleteVarConfirm: "Delete",

  dangerZone: "Danger Zone",
  dangerZoneDesc: "Irreversible and destructive actions",
  deleteProfile: "Delete Profile",
  deleteProfileTitle: "Delete Profile",
  deleteProfileBody:
    "This will permanently delete the profile, user account, and all associated data. This action cannot be undone.",
  deleteProfileConfirm: "Delete Profile",
  deleteProfileFailed: "Failed to delete profile.",
} as const;

// ── Helpers ──

function formatUptime(secs: number | null): string {
  if (secs == null) return "N/A";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Types ──

interface ProfileTabProps {
  profile: Profile;
  onProfileUpdated: (p: Profile) => void;
  onNavigateBack?: () => void;
}

type GatewayAction = "start" | "stop" | "restart";

interface EnvVarRow {
  key: string;
  value: string;
  maskedValue: string; // original masked value from server
  isNew: boolean;
  editing: boolean;
}

// ── Component ──

export function ProfileTab({ profile, onProfileUpdated, onNavigateBack }: ProfileTabProps) {
  // Profile name + editable fields
  const [name, setName] = useState(profile.name);
  const [autoStart, setAutoStart] = useState(profile.enabled);
  const [adminMode, setAdminMode] = useState(profile.config.admin_mode);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Gateway controls
  const [gatewayLoading, setGatewayLoading] = useState<GatewayAction | null>(
    null,
  );
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<"stop" | "restart" | null>(
    null,
  );

  // Env vars
  const [envRows, setEnvRows] = useState<EnvVarRow[]>(() =>
    Object.entries(profile.config.env_vars ?? {}).map(([key, val]) => ({
      key,
      value: "",
      maskedValue: val,
      isNew: false,
      editing: false,
    })),
  );
  const [envSaving, setEnvSaving] = useState(false);
  const [envSaved, setEnvSaved] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [deleteIdx, setDeleteIdx] = useState<number | null>(null);

  // Delete profile
  const [deleteProfileOpen, setDeleteProfileOpen] = useState(false);
  const [deleteProfileError, setDeleteProfileError] = useState<string | null>(null);

  // ── Profile save ──

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateMyProfile({
        name: name.trim(),
        enabled: autoStart,
        config: {
          admin_mode: adminMode,
        },
      });
      onProfileUpdated(result);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(formatSettingsError(err, LABELS.saveFailed));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProfile = async () => {
    setDeleteProfileError(null);
    try {
      await deleteAdminProfile(profile.id);
      onNavigateBack?.();
    } catch (err) {
      setDeleteProfileError(formatSettingsError(err, LABELS.deleteProfileFailed));
    }
  };

  // ── Gateway controls ──

  const refreshProfile = useCallback(async () => {
    const fresh = await getMyProfile();
    if (fresh) onProfileUpdated(fresh);
  }, [onProfileUpdated]);

  const handleGatewayAction = useCallback(
    async (action: GatewayAction) => {
      setGatewayLoading(action);
      setGatewayError(null);
      const fn =
        action === "start"
          ? startMyGateway
          : action === "stop"
            ? stopMyGateway
            : restartMyGateway;
      try {
        const result = await fn();
        if (!result.ok) {
          setGatewayError(result.message ?? `Failed to ${action} gateway.`);
        }
      } catch (err) {
        setGatewayError(formatSettingsError(err, `Failed to ${action} gateway.`));
      } finally {
        await refreshProfile();
        setGatewayLoading(null);
      }
    },
    [refreshProfile],
  );

  const onConfirmGatewayAction = useCallback(() => {
    if (confirmAction) {
      handleGatewayAction(confirmAction);
    }
    setConfirmAction(null);
  }, [confirmAction, handleGatewayAction]);

  const isRunning = profile.status.running;

  // ── Env vars CRUD ──

  const handleAddVar = () => {
    setEnvRows((rows) => [
      ...rows,
      { key: "", value: "", maskedValue: "", isNew: true, editing: true },
    ]);
  };

  const handleEditVar = (idx: number) => {
    setEnvRows((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, editing: true } : r)),
    );
  };

  const handleDeleteVar = () => {
    if (deleteIdx == null) return;
    setEnvRows((rows) => rows.filter((_, i) => i !== deleteIdx));
    setDeleteIdx(null);
  };

  const updateRow = (idx: number, field: "key" | "value", val: string) => {
    setEnvRows((rows) =>
      rows.map((r, i) => (i === idx ? { ...r, [field]: val } : r)),
    );
  };

  const envIsDirty = envRows.some(
    (r) => r.isNew || r.editing || r.value !== "",
  );

  const handleSaveEnvVars = async () => {
    setEnvSaving(true);
    setEnvError(null);

    // Build a partial env_vars object with only changed/new values.
    // Deleted keys are handled by sending the full replacement set.
    const envVars: Record<string, string> = {};
    for (const row of envRows) {
      if (!row.key.trim()) continue;
      // Only include rows that have a new value typed in
      if (row.value) {
        envVars[row.key.trim()] = row.value;
      } else if (!row.isNew) {
        // Existing var without new value: send masked value to keep it
        envVars[row.key.trim()] = row.maskedValue;
      }
    }

    try {
      const result = await updateMyProfile({ config: { env_vars: envVars } });
      onProfileUpdated(result);
      // Reset rows from fresh server data
      setEnvRows(
        Object.entries(result.config.env_vars ?? {}).map(([key, val]) => ({
          key,
          value: "",
          maskedValue: val,
          isNew: false,
          editing: false,
        })),
      );
      setEnvSaved(true);
      setTimeout(() => setEnvSaved(false), 2000);
    } catch (err) {
      setEnvError(formatSettingsError(err, LABELS.envSaveFailed));
    } finally {
      setEnvSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Profile info card ── */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <User size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              {LABELS.profileInfo}
            </h3>
            <p className="text-xs text-muted">{LABELS.profileInfoDesc}</p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Profile ID (read-only) */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              {LABELS.profileId}
            </label>
            <div className="rounded-xl bg-surface-dark/50 px-4 py-3 text-sm text-muted font-mono">
              {profile.id}
            </div>
          </div>

          {/* Name (editable) */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              {LABELS.displayName}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={LABELS.displayNamePlaceholder}
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
            />
          </div>

          {/* Auto-start Gateway (toggle) */}
          <div className="flex items-center justify-between rounded-xl bg-surface-container/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-text-strong">
                {LABELS.autoStart}
              </p>
              <p className="text-xs text-muted mt-0.5">{LABELS.autoStartDesc}</p>
            </div>
            <button
              role="switch"
              aria-checked={autoStart}
              onClick={() => setAutoStart((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                autoStart ? "bg-accent" : "bg-surface-dark"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  autoStart ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {/* Admin Mode (toggle) */}
          <div className="flex items-center justify-between rounded-xl bg-surface-container/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-text-strong">
                {LABELS.adminMode}
              </p>
              <p className="text-xs text-muted mt-0.5">{LABELS.adminModeDesc}</p>
            </div>
            <button
              role="switch"
              aria-checked={adminMode}
              onClick={() => setAdminMode((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                adminMode ? "bg-accent" : "bg-surface-dark"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  adminMode ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {/* Created at */}
          {profile.created_at && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                {LABELS.created}
              </label>
              <div className="rounded-xl bg-surface-dark/50 px-4 py-3 text-sm text-muted">
                {new Date(profile.created_at).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </div>
            </div>
          )}
        </div>

        {/* Save button */}
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={
              saving ||
              !name.trim() ||
              (name.trim() === profile.name &&
                autoStart === profile.enabled &&
                adminMode === profile.config.admin_mode)
            }
            className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : saved ? (
              <Check size={14} />
            ) : (
              <Save size={14} />
            )}
            {saved ? LABELS.saved : LABELS.saveChanges}
          </button>
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>

      {/* ── Gateway status + controls card ── */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Activity size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              {LABELS.gatewayStatus}
            </h3>
            <p className="text-xs text-muted">{LABELS.gatewayStatusDesc}</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl bg-surface-container/60 px-4 py-3">
            <span className="text-xs font-medium text-muted">
              {LABELS.status}
            </span>
            <span
              className={`text-xs font-medium ${isRunning ? "text-green-400" : "text-muted/60"}`}
            >
              {isRunning ? LABELS.running : LABELS.stopped}
            </span>
          </div>
          {profile.status.pid != null && (
            <div className="flex items-center justify-between rounded-xl bg-surface-container/60 px-4 py-3">
              <span className="text-xs font-medium text-muted">
                {LABELS.pid}
              </span>
              <span className="text-xs font-mono text-text">
                {profile.status.pid}
              </span>
            </div>
          )}
          {profile.status.uptime_secs != null && (
            <div className="flex items-center justify-between rounded-xl bg-surface-container/60 px-4 py-3">
              <span className="text-xs font-medium text-muted">
                {LABELS.uptime}
              </span>
              <span className="text-xs font-mono text-text">
                {formatUptime(profile.status.uptime_secs)}
              </span>
            </div>
          )}
        </div>

        {/* Gateway action buttons */}
        <div className="mt-5 flex items-center gap-3 flex-wrap">
          {/* Start */}
          <button
            onClick={() => handleGatewayAction("start")}
            disabled={isRunning || gatewayLoading != null}
            className="flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-30 transition"
          >
            {gatewayLoading === "start" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            {LABELS.start}
          </button>

          {/* Stop (requires confirmation) */}
          <button
            onClick={() => setConfirmAction("stop")}
            disabled={!isRunning || gatewayLoading != null}
            className="flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-30 transition"
          >
            {gatewayLoading === "stop" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Square size={14} />
            )}
            {LABELS.stop}
          </button>

          {/* Restart (requires confirmation) */}
          <button
            onClick={() => setConfirmAction("restart")}
            disabled={!isRunning || gatewayLoading != null}
            className="flex items-center gap-2 rounded-xl bg-yellow-500 px-4 py-2 text-sm font-medium text-black hover:bg-yellow-600 disabled:opacity-30 transition"
          >
            {gatewayLoading === "restart" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RotateCcw size={14} />
            )}
            {LABELS.restart}
          </button>
        </div>

        {gatewayError && (
          <p className="mt-3 text-xs text-red-400">{gatewayError}</p>
        )}
      </div>

      {/* ── Environment Variables card ── */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <KeyRound size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">
                {LABELS.envVars}
              </h3>
              <p className="text-xs text-muted">{LABELS.envVarsDesc}</p>
            </div>
          </div>
          <button
            onClick={handleAddVar}
            className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-muted hover:text-text-strong hover:border-accent/30 transition"
          >
            <Plus size={14} />
            {LABELS.addVariable}
          </button>
        </div>

        {envRows.length === 0 ? (
          <div className="rounded-xl bg-surface-dark/50 px-6 py-10 text-center">
            <KeyRound size={32} className="mx-auto mb-3 text-muted/40" />
            <p className="text-sm text-muted">{LABELS.noEnvVars}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {envRows.map((row, idx) => (
              <div
                key={idx}
                className="flex items-center gap-3 rounded-xl bg-surface-container/60 px-4 py-3 border border-transparent hover:border-border transition"
              >
                {/* Key */}
                {row.isNew || row.editing ? (
                  <input
                    type="text"
                    value={row.key}
                    onChange={(e) =>
                      updateRow(idx, "key", e.target.value.toUpperCase())
                    }
                    placeholder={LABELS.keyPlaceholder}
                    disabled={!row.isNew}
                    className="w-40 shrink-0 rounded-lg bg-surface-dark/50 px-3 py-2 text-xs font-mono text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition disabled:opacity-60"
                  />
                ) : (
                  <span className="w-40 shrink-0 text-xs font-mono font-medium text-text-strong truncate">
                    {row.key}
                  </span>
                )}

                {/* Value */}
                {row.editing ? (
                  <input
                    type="text"
                    value={row.value}
                    onChange={(e) => updateRow(idx, "value", e.target.value)}
                    placeholder={
                      row.isNew
                        ? LABELS.valuePlaceholder
                        : row.maskedValue || LABELS.valueMaskedPlaceholder
                    }
                    className="flex-1 min-w-0 rounded-lg bg-surface-dark/50 px-3 py-2 text-xs font-mono text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
                  />
                ) : (
                  <span className="flex-1 min-w-0 text-xs font-mono text-muted truncate">
                    {row.maskedValue || "***"}
                  </span>
                )}

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {!row.editing && (
                    <button
                      onClick={() => handleEditVar(idx)}
                      className="rounded-lg p-1.5 text-muted hover:text-accent hover:bg-surface-dark/50 transition"
                      title="Edit"
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => setDeleteIdx(idx)}
                    className="rounded-lg p-1.5 text-muted hover:text-red-400 hover:bg-surface-dark/50 transition"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Save env vars */}
        {envRows.length > 0 && (
          <div className="mt-5 flex items-center gap-3">
            <button
              onClick={handleSaveEnvVars}
              disabled={envSaving || !envIsDirty}
              className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
            >
              {envSaving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : envSaved ? (
                <Check size={14} />
              ) : (
                <Save size={14} />
              )}
              {envSaved ? LABELS.envSaved : LABELS.saveEnvVars}
            </button>
            {envError && (
              <span className="text-xs text-red-400">{envError}</span>
            )}
          </div>
        )}
      </div>

      {/* ── Danger zone ── */}
      <div className="mt-2 border-t border-border/40 pt-6">
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-400">
              <AlertTriangle size={20} />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-red-400">
                {LABELS.dangerZone}
              </h3>
              <p className="text-xs text-muted">{LABELS.dangerZoneDesc}</p>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl bg-surface-container/40 px-4 py-3">
            <div>
              <p className="text-sm font-medium text-text-strong">
                {LABELS.deleteProfile}
              </p>
              <p className="text-xs text-muted mt-0.5">
                {LABELS.deleteProfileBody}
              </p>
            </div>
            <button
              onClick={() => setDeleteProfileOpen(true)}
              className="ml-4 shrink-0 flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition"
            >
              <Trash2 size={14} />
              {LABELS.deleteProfile}
            </button>
          </div>

          {deleteProfileError && (
            <p className="mt-3 text-xs text-red-400">{deleteProfileError}</p>
          )}
        </div>
      </div>

      {/* ── Confirm dialogs ── */}
      <ConfirmDialog
        open={confirmAction === "stop"}
        title={LABELS.stopTitle}
        body={LABELS.stopBody}
        confirmLabel={LABELS.stopConfirm}
        variant="danger"
        onConfirm={onConfirmGatewayAction}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === "restart"}
        title={LABELS.restartTitle}
        body={LABELS.restartBody}
        confirmLabel={LABELS.restartConfirm}
        variant="warning"
        onConfirm={onConfirmGatewayAction}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={deleteIdx != null}
        title={LABELS.deleteVarTitle}
        body={
          deleteIdx != null && envRows[deleteIdx]
            ? `Remove "${envRows[deleteIdx].key || "this variable"}" from environment variables?`
            : ""
        }
        confirmLabel={LABELS.deleteVarConfirm}
        variant="danger"
        onConfirm={handleDeleteVar}
        onCancel={() => setDeleteIdx(null)}
      />
      <ConfirmDialog
        open={deleteProfileOpen}
        title={LABELS.deleteProfileTitle}
        body={LABELS.deleteProfileBody}
        confirmLabel={LABELS.deleteProfileConfirm}
        variant="danger"
        onConfirm={handleDeleteProfile}
        onCancel={() => setDeleteProfileOpen(false)}
      />
    </div>
  );
}
