import { useState } from "react";
import { Save, Loader2, Check, AlertCircle } from "lucide-react";
import {
  updateMyProfileConfig,
  formatSettingsError,
  type Profile,
  type CloudTtsConfig,
} from "./settings-api";

const TOKEN_ENV = "VOLC_TTS_TOKEN";
const ROUTES: { id: string; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "Cloud when a token is set, else on-device." },
  { id: "local", label: "Local (on-device)", hint: "Local ominix-api engine." },
  { id: "cloud", label: "Cloud (Volcano)", hint: "Volcano Engine cloud TTS." },
];

function isMasked(v: string | undefined): boolean {
  return !!v && (v.includes("***") || v.includes("\u{1f511}"));
}

export function VoiceTab({
  profile,
  onProfileUpdated,
}: {
  profile: Profile;
  onProfileUpdated: (p: Profile) => void;
}) {
  const cfg = profile.config;
  const storedToken = cfg.env_vars?.[TOKEN_ENV] ?? "";

  const [route, setRoute] = useState(cfg.tts_provider ?? "auto");
  const [cloud, setCloud] = useState<CloudTtsConfig>({ ...(cfg.tts_cloud ?? {}) });
  // empty input = leave the stored (masked) token untouched
  const [tokenInput, setTokenInput] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showCloud = route === "auto" || route === "cloud";
  const tokenSet = isMasked(storedToken) || storedToken.length > 0;
  const tokenWarning = route === "cloud" && !tokenSet && !tokenInput;

  const setCloudField = (k: keyof CloudTtsConfig, v: string) =>
    setCloud((c) => ({ ...c, [k]: v }));

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const envVars = { ...(cfg.env_vars ?? {}) };
      // Only overwrite the token when the user typed a new value; otherwise
      // re-send the stored masked value so the backend restores the real one.
      if (tokenInput) envVars[TOKEN_ENV] = tokenInput;
      const updated = await updateMyProfileConfig(profile, {
        tts_provider: route,
        tts_cloud: cloud,
        env_vars: envVars,
      });
      onProfileUpdated(updated);
      setTokenInput("");
      setSaved(true);
    } catch (err) {
      setError(formatSettingsError(err, "Failed to update voice config."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <label htmlFor="tts-route" className="block text-sm font-medium">
          TTS route
        </label>
        <select
          id="tts-route"
          value={route}
          onChange={(e) => setRoute(e.target.value)}
          className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
        >
          {ROUTES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs opacity-70">
          {ROUTES.find((r) => r.id === route)?.hint}
        </p>
      </div>

      {showCloud && (
        <div className="space-y-4 rounded-lg border p-4">
          <div className="text-sm font-medium">Volcano (cloud) credentials</div>

          <Field label="App ID" htmlFor="volc-appid">
            <input
              id="volc-appid"
              value={cloud.appid ?? ""}
              onChange={(e) => setCloudField("appid", e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </Field>

          <Field
            label={`Token${tokenSet ? " (已设置)" : ""}`}
            htmlFor="volc-token"
          >
            <input
              id="volc-token"
              type="password"
              value={tokenInput}
              placeholder={tokenSet ? "•••••• (unchanged)" : "Enter token"}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </Field>

          <Field label="Voice" htmlFor="volc-voice">
            <input
              id="volc-voice"
              value={cloud.voice ?? ""}
              placeholder="BV001_streaming"
              onChange={(e) => setCloudField("voice", e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </Field>

          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="text-xs underline opacity-70"
          >
            {showAdvanced ? "Hide advanced" : "Advanced"}
          </button>
          {showAdvanced && (
            <div className="space-y-4">
              <Field label="Cluster" htmlFor="volc-cluster">
                <input
                  id="volc-cluster"
                  value={cloud.cluster ?? ""}
                  placeholder="volcano_tts"
                  onChange={(e) => setCloudField("cluster", e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Encoding" htmlFor="volc-encoding">
                <input
                  id="volc-encoding"
                  value={cloud.encoding ?? ""}
                  placeholder="mp3"
                  onChange={(e) => setCloudField("encoding", e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Endpoint" htmlFor="volc-endpoint">
                <input
                  id="volc-endpoint"
                  value={cloud.endpoint ?? ""}
                  placeholder="https://openspeech.bytedance.com/api/v1/tts"
                  onChange={(e) => setCloudField("endpoint", e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </Field>
            </div>
          )}

          {tokenWarning && (
            <p className="flex items-center gap-1 text-xs text-amber-600">
              <AlertCircle size={12} /> 未填 token 将回退端侧
            </p>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
        {saving ? "Saving…" : "Save"}
      </button>
      <p className="text-xs opacity-60">Restart the profile to apply credential changes.</p>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
