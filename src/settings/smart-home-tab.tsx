// Smart Home tab — the configuration surface for the per-profile
// smart-home bridge (`config.smart_home`). Until this existed the bridge
// could only be configured by hand-editing the profile JSON or a raw
// `PUT /api/my/profile`, even though the backend, the dashboard widget,
// and the conversation skill were all wired up (the skill's SKILL.md
// already pointed users at "Settings → Smart Home").
//
// Save goes through the same generic profile-config JSON-merge-patch as
// every other tab. The token comes back MASKED from the server; the
// backend's `save_with_merge` restores a masked echo, so this tab only
// sends a new token value when the user actually types one.
import { useState } from "react";
import { Home, Loader2, PlugZap } from "lucide-react";

import { METHODS } from "@/runtime/ui-protocol-bridge";
import { ensureAuxBridge } from "@/runtime/ui-protocol-runtime";
import {
  formatSettingsError,
  updateMyProfileConfig,
  type Profile,
  type SmartHomeProfileConfig,
} from "./settings-api";

const INPUT_CLASS =
  "w-full rounded-xl bg-surface-container px-4 py-2.5 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition";

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-muted">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1.5 text-xs text-muted/80">{hint}</p> : null}
    </div>
  );
}

interface DeviceListProbe {
  devices: {
    ok?: boolean;
    error?: string;
    devices?: unknown[];
  };
}

export function SmartHomeTab({
  profile,
  onProfileUpdated,
}: {
  profile: Profile;
  onProfileUpdated: (p: Profile) => void;
}) {
  const current: SmartHomeProfileConfig = profile.config.smart_home ?? {};
  const [bridgeUrl, setBridgeUrl] = useState(current.bridge_url ?? "");
  // Empty input = leave the stored (masked) token untouched.
  const [tokenInput, setTokenInput] = useState("");
  const [tokenEnv, setTokenEnv] = useState(current.token_env ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const tokenSet = Boolean(current.token);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const trimmedUrl = bridgeUrl.trim();
      const trimmedEnv = tokenEnv.trim();
      // Whole-section value: `null` clears the section entirely.
      const section: SmartHomeProfileConfig | null = trimmedUrl
        ? {
            bridge_url: trimmedUrl,
            // Echo the masked value unless the user typed a new token —
            // `save_with_merge` restores a masked echo to the real secret.
            token: tokenInput ? tokenInput : (current.token ?? null),
            token_env: trimmedEnv ? trimmedEnv : null,
          }
        : null;
      const updated = await updateMyProfileConfig(profile, { smart_home: section });
      onProfileUpdated(updated);
      setTokenInput("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(formatSettingsError(err, "Failed to update smart-home config."));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const bridge = await ensureAuxBridge();
      const result = await bridge.callMethod<DeviceListProbe>(
        METHODS.SMART_HOME_DEVICE_LIST,
        {},
      );
      const data = result.devices;
      if (data.ok === false) {
        setTestResult(`Bridge error: ${data.error ?? "unknown error"}`);
      } else {
        const count = Array.isArray(data.devices) ? data.devices.length : 0;
        setTestResult(`Connected — ${count} device${count === 1 ? "" : "s"} found.`);
      }
    } catch (err) {
      setTestResult(formatSettingsError(err, "Bridge is not reachable."));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="glass-section rounded-lg p-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Home size={18} />
          </div>
          <div>
            <h2 className="text-sm font-semibold">Smart Home Bridge</h2>
            <p className="text-xs text-muted">
              Self-hosted bridge (e.g. Home Assistant) on your own network. Powers the
              home dashboard widget and lets the agent list and control devices in chat.
            </p>
          </div>
        </div>

        <div className="space-y-5">
          <Field
            label="Bridge URL"
            htmlFor="sh-bridge-url"
            hint="Base URL of the bridge on your LAN. Leave empty to disconnect."
          >
            <input
              id="sh-bridge-url"
              value={bridgeUrl}
              placeholder="http://192.168.1.50:8787"
              onChange={(e) => setBridgeUrl(e.target.value)}
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            label={`Auth token${tokenSet ? " (set)" : ""}`}
            htmlFor="sh-token"
            hint="Sent as a Bearer token. Leave empty to keep the current one."
          >
            <input
              id="sh-token"
              type="password"
              value={tokenInput}
              placeholder={tokenSet ? "•••••• (unchanged)" : "Optional"}
              onChange={(e) => setTokenInput(e.target.value)}
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            label="Token env var"
            htmlFor="sh-token-env"
            hint="Alternative to a literal token: the name of a profile env var holding it."
          >
            <input
              id="sh-token-env"
              value={tokenEnv}
              placeholder="SMART_HOME_TOKEN"
              onChange={(e) => setTokenEnv(e.target.value)}
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-30 transition"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={testing}
            className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium transition hover:bg-surface-container disabled:opacity-50"
          >
            {testing ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
            {testing ? "Testing…" : "Test connection"}
          </button>
          {saved ? <span className="text-sm text-accent">Saved.</span> : null}
        </div>

        {testResult ? <p className="mt-3 text-sm text-muted">{testResult}</p> : null}
        {error ? (
          <p role="alert" className="mt-3 text-xs text-red-400">
            {error}
          </p>
        ) : null}
      </div>

      <div className="glass-section rounded-lg p-6">
        <h3 className="mb-2 text-sm font-semibold">Using it in chat</h3>
        <p className="text-xs leading-relaxed text-muted">
          Once a bridge is configured, the agent's smart-home skill can answer
          "turn on the living room lamp" style requests: it lists devices through
          the bridge, then sends the command. Camera video stays dashboard-only.
        </p>
      </div>
    </div>
  );
}
