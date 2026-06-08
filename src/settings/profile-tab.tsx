import { useState } from "react";
import { User, Save, Loader2, Check, Activity } from "lucide-react";
import { updateMyProfile, type Profile } from "./settings-api";

interface ProfileTabProps {
  profile: Profile;
  onProfileUpdated: (p: Profile) => void;
}

function formatUptime(secs: number | null): string {
  if (secs == null) return "N/A";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function ProfileTab({ profile, onProfileUpdated }: ProfileTabProps) {
  const [name, setName] = useState(profile.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    const result = await updateMyProfile({ name: name.trim() });
    setSaving(false);
    if (result) {
      onProfileUpdated(result);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError("Failed to update profile.");
    }
  };

  return (
    <div className="space-y-6">
      {/* Profile info card */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <User size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">Profile Information</h3>
            <p className="text-xs text-muted">Manage your profile details</p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Profile ID (read-only) */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Profile ID
            </label>
            <div className="rounded-xl bg-surface-dark/50 px-4 py-3 text-sm text-muted font-mono">
              {profile.id}
            </div>
          </div>

          {/* Name (editable) */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Display Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter display name"
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
            />
          </div>

          {/* Created at */}
          {profile.created_at && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                Created
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
            disabled={saving || !name.trim() || name.trim() === profile.name}
            className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : saved ? (
              <Check size={14} />
            ) : (
              <Save size={14} />
            )}
            {saved ? "Saved" : "Save Changes"}
          </button>
          {error && (
            <span className="text-xs text-red-400">{error}</span>
          )}
        </div>
      </div>

      {/* Gateway status card */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Activity size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">Gateway Status</h3>
            <p className="text-xs text-muted">Runtime status of the gateway process</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-xl bg-surface-container/60 px-4 py-3">
            <span className="text-xs font-medium text-muted">Status</span>
            <span className={`text-xs font-medium ${profile.status.running ? "text-green-400" : "text-muted/60"}`}>
              {profile.status.running ? "Running" : "Stopped"}
            </span>
          </div>
          {profile.status.pid != null && (
            <div className="flex items-center justify-between rounded-xl bg-surface-container/60 px-4 py-3">
              <span className="text-xs font-medium text-muted">PID</span>
              <span className="text-xs font-mono text-text">{profile.status.pid}</span>
            </div>
          )}
          {profile.status.uptime_secs != null && (
            <div className="flex items-center justify-between rounded-xl bg-surface-container/60 px-4 py-3">
              <span className="text-xs font-medium text-muted">Uptime</span>
              <span className="text-xs font-mono text-text">
                {formatUptime(profile.status.uptime_secs)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
