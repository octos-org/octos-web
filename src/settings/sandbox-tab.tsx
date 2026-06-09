import { useState } from "react";
import {
  Shield,
  Save,
  Loader2,
  Check,
  RotateCcw,
  Plus,
  X,
} from "lucide-react";
import { updateMyProfile, type Profile, type SandboxConfig, type SandboxDocker } from "./settings-api";

interface SandboxTabProps {
  profile: Profile;
  onProfileUpdated: (p: Profile) => void;
}

const SANDBOX_MODES = [
  { value: "auto", label: "Auto", description: "Automatically select the best isolation method" },
  { value: "docker", label: "Docker", description: "Docker container isolation" },
  { value: "sandbox-exec", label: "sandbox-exec", description: "macOS sandbox" },
  { value: "bubblewrap", label: "Bubblewrap", description: "Linux namespace isolation" },
  { value: "appcontainer", label: "AppContainer", description: "Windows AppContainer" },
  { value: "host", label: "Host", description: "No isolation (runs directly on host)" },
] as const;

const MOUNT_MODES = [
  { value: "rw", label: "Read-Write" },
  { value: "ro", label: "Read-Only" },
] as const;

interface SandboxFormState {
  enabled: boolean;
  mode: string;
  allow_network: boolean;
  docker_image: string;
  docker_cpu_limit: string;
  docker_memory_limit: string;
  docker_pids_limit: string;
  docker_mount_mode: string;
  docker_extra_binds: string[];
  read_allow_paths: string[];
}

function profileToForm(profile: Profile): SandboxFormState {
  const sb = profile.config.sandbox;
  return {
    enabled: sb?.enabled ?? false,
    mode: sb?.mode ?? "auto",
    allow_network: sb?.allow_network ?? true,
    docker_image: sb?.docker?.image ?? "ubuntu:24.04",
    docker_cpu_limit: sb?.docker?.cpu_limit ?? "",
    docker_memory_limit: sb?.docker?.memory_limit ?? "",
    docker_pids_limit: sb?.docker?.pids_limit != null ? String(sb.docker.pids_limit) : "",
    docker_mount_mode: sb?.docker?.mount_mode ?? "rw",
    docker_extra_binds: sb?.docker?.extra_binds ?? [],
    read_allow_paths: sb?.read_allow_paths ?? [],
  };
}

function formToSandboxConfig(form: SandboxFormState): SandboxConfig {
  const docker: SandboxDocker = {
    image: form.docker_image.trim() || "ubuntu:24.04",
    cpu_limit: form.docker_cpu_limit.trim() || null,
    memory_limit: form.docker_memory_limit.trim() || null,
    pids_limit: form.docker_pids_limit.trim() ? parseInt(form.docker_pids_limit, 10) || null : null,
    mount_mode: form.docker_mount_mode,
    extra_binds: form.docker_extra_binds.filter((b) => b.trim()),
  };
  return {
    enabled: form.enabled,
    mode: form.mode,
    allow_network: form.allow_network,
    docker,
    read_allow_paths: form.read_allow_paths.filter((p) => p.trim()),
  };
}

/* ── Reusable editable string-list component ── */

function StringListEditor({
  items,
  onItemsChange,
  placeholder,
}: {
  items: string[];
  onItemsChange: (items: string[]) => void;
  placeholder: string;
}) {
  const addItem = () => onItemsChange([...items, ""]);
  const removeItem = (idx: number) => onItemsChange(items.filter((_, i) => i !== idx));
  const updateItem = (idx: number, value: string) =>
    onItemsChange(items.map((v, i) => (i === idx ? value : v)));

  return (
    <div className="space-y-2">
      {items.map((item, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <input
            type="text"
            value={item}
            onChange={(e) => updateItem(idx, e.target.value)}
            placeholder={placeholder}
            className="flex-1 rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
          />
          <button
            type="button"
            onClick={() => removeItem(idx)}
            className="shrink-0 rounded-lg p-2 text-muted hover:text-red-400 hover:bg-red-500/10 transition"
            title="Remove"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-muted hover:text-accent hover:bg-accent/10 transition"
      >
        <Plus size={12} />
        Add entry
      </button>
    </div>
  );
}

/* ── Toggle component ── */

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-4 cursor-pointer">
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-text-strong">{label}</span>
        {description && (
          <p className="text-xs text-muted mt-0.5">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-accent" : "bg-surface-container"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
    </label>
  );
}

export function SandboxTab({ profile, onProfileUpdated }: SandboxTabProps) {
  const [form, setForm] = useState<SandboxFormState>(() => profileToForm(profile));
  const [original, setOriginal] = useState<SandboxFormState>(() => profileToForm(profile));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);
  const isDockerMode = form.mode === "docker";

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const result = await updateMyProfile({
      config: { sandbox: formToSandboxConfig(form) },
    });
    setSaving(false);
    if (result) {
      onProfileUpdated(result);
      const newForm = profileToForm(result);
      setForm(newForm);
      setOriginal(newForm);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError("Failed to update sandbox config.");
    }
  };

  const handleReset = () => setForm({ ...original, docker_extra_binds: [...original.docker_extra_binds], read_allow_paths: [...original.read_allow_paths] });

  return (
    <div className="space-y-6">
      {/* Main sandbox config card */}
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Shield size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">Sandbox Configuration</h3>
            <p className="text-xs text-muted">Configure tool execution isolation and security</p>
          </div>
        </div>

        <div className="space-y-5">
          {/* Enabled toggle */}
          <Toggle
            checked={form.enabled}
            onChange={(val) => setForm((f) => ({ ...f, enabled: val }))}
            label="Enable Sandbox"
            description="Isolate tool execution in a sandboxed environment"
          />

          {/* Mode selector */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Isolation Mode
            </label>
            <select
              value={form.mode}
              onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text outline-none border border-transparent focus:border-accent/30 transition"
            >
              {SANDBOX_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            {SANDBOX_MODES.find((m) => m.value === form.mode) && (
              <p className="mt-1.5 text-xs text-muted">
                {SANDBOX_MODES.find((m) => m.value === form.mode)?.description}
              </p>
            )}
          </div>

          {/* Allow network toggle */}
          <Toggle
            checked={form.allow_network}
            onChange={(val) => setForm((f) => ({ ...f, allow_network: val }))}
            label="Allow Network Access"
            description="When disabled, tools run in a fully offline environment (Docker: --network=none)"
          />

          {/* Read Allow Paths */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Read-Allowed Paths
            </label>
            <p className="mb-2 text-xs text-muted/70">
              Filesystem paths the sandbox is permitted to read
            </p>
            <StringListEditor
              items={form.read_allow_paths}
              onItemsChange={(paths) => setForm((f) => ({ ...f, read_allow_paths: paths }))}
              placeholder="/path/to/allow"
            />
          </div>
        </div>
      </div>

      {/* Docker-specific config card */}
      {isDockerMode && (
        <div className="glass-section rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400">
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
                <path d="M13.98 11.08h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19h-2.12a.19.19 0 0 0-.19.19v1.88c0 .1.08.19.19.19m-2.95-5.43h2.12a.19.19 0 0 0 .19-.19V3.58a.19.19 0 0 0-.19-.19h-2.12a.19.19 0 0 0-.19.19v1.88c0 .1.09.19.19.19m0 2.71h2.12a.19.19 0 0 0 .19-.19V6.29a.19.19 0 0 0-.19-.19h-2.12a.19.19 0 0 0-.19.19v1.88c0 .11.09.19.19.19m-2.93 0h2.12a.19.19 0 0 0 .19-.19V6.29a.19.19 0 0 0-.19-.19H8.1a.19.19 0 0 0-.19.19v1.88c0 .11.08.19.19.19m-2.96 0h2.12a.19.19 0 0 0 .19-.19V6.29a.19.19 0 0 0-.19-.19H5.14a.19.19 0 0 0-.19.19v1.88c0 .11.09.19.19.19m5.89 2.72h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19h-2.12a.19.19 0 0 0-.19.19v1.88c0 .1.09.19.19.19m-2.93 0h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19H8.1a.19.19 0 0 0-.19.19v1.88c0 .1.08.19.19.19m-2.96 0h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19H5.14a.19.19 0 0 0-.19.19v1.88c0 .1.09.19.19.19m-2.92 0h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19H2.22a.19.19 0 0 0-.19.19v1.88c0 .1.08.19.19.19m21.54-1.19c-.06-.04-.42-.28-1.23-.28-.21 0-.43.02-.65.06-.29-1.96-1.82-2.91-1.89-2.95l-.38-.22-.24.36c-.3.47-.52.99-.65 1.53-.24 1.04-.09 2.02.41 2.86-.61.34-1.59.42-1.88.43H.99a.99.99 0 0 0-.99.99c.02 1.83.29 3.65.87 5.21.63 1.63 1.57 2.83 2.8 3.57 1.38.83 3.63 1.31 6.13 1.31.59 0 1.19-.04 1.79-.12 2.1-.25 4.1-.89 5.86-2.06 1.43-.96 2.72-2.26 3.64-3.88.92-1.63 1.32-3.1 1.55-4.31h.13c.81 0 1.31-.32 1.58-.59.19-.17.33-.39.44-.62l.06-.17z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-text-strong">Docker Settings</h3>
              <p className="text-xs text-muted">Container isolation configuration</p>
            </div>
          </div>

          <div className="space-y-5">
            {/* Docker image */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                Docker Image
              </label>
              <input
                type="text"
                value={form.docker_image}
                onChange={(e) => setForm((f) => ({ ...f, docker_image: e.target.value }))}
                placeholder="ubuntu:24.04"
                className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
              />
            </div>

            {/* Resource limits row */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">
                  CPU Limit
                </label>
                <input
                  type="text"
                  value={form.docker_cpu_limit}
                  onChange={(e) => setForm((f) => ({ ...f, docker_cpu_limit: e.target.value }))}
                  placeholder="1.0"
                  className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">
                  Memory Limit
                </label>
                <input
                  type="text"
                  value={form.docker_memory_limit}
                  onChange={(e) => setForm((f) => ({ ...f, docker_memory_limit: e.target.value }))}
                  placeholder="512m"
                  className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">
                  PID Limit
                </label>
                <input
                  type="number"
                  value={form.docker_pids_limit}
                  onChange={(e) => setForm((f) => ({ ...f, docker_pids_limit: e.target.value }))}
                  placeholder="256"
                  min={1}
                  className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition font-mono"
                />
              </div>
            </div>

            {/* Mount mode */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                Mount Mode
              </label>
              <div className="flex gap-3">
                {MOUNT_MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, docker_mount_mode: m.value }))}
                    className={`flex-1 rounded-xl px-4 py-3 text-sm font-medium transition border ${
                      form.docker_mount_mode === m.value
                        ? "bg-accent/12 text-accent border-accent/20"
                        : "bg-surface-container text-muted border-transparent hover:border-border"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Extra binds */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">
                Extra Bind Mounts
              </label>
              <p className="mb-2 text-xs text-muted/70">
                Additional host paths to mount into the container
              </p>
              <StringListEditor
                items={form.docker_extra_binds}
                onItemsChange={(binds) => setForm((f) => ({ ...f, docker_extra_binds: binds }))}
                placeholder="/host/path:/container/path"
              />
            </div>
          </div>
        </div>
      )}

      {/* Save actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
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
        {isDirty && (
          <button
            onClick={handleReset}
            className="flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm text-muted hover:text-text-strong hover:border-accent/30 transition"
          >
            <RotateCcw size={14} />
            Reset
          </button>
        )}
        {error && (
          <span className="text-xs text-red-400">{error}</span>
        )}
      </div>
    </div>
  );
}
