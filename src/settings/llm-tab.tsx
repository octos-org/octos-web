import { useState } from "react";
import {
  Cpu,
  Save,
  Loader2,
  Check,
  RotateCcw,
  Plug,
  Settings2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Shuffle,
  Info,
} from "lucide-react";
import { request } from "@/api/client";
import {
  formatSettingsError,
  updateMyProfile,
  type Profile,
  type LlmPrimary,
} from "./settings-api";
import {
  LLM_PROVIDERS,
  findProvider,
  showsBaseUrl,
  type LlmProvider,
} from "./llm-providers";

/* ─── Props ─── */

interface LlmTabProps {
  profile: Profile;
  onProfileUpdated: (p: Profile) => void;
}

/* ─── Form State ─── */

interface FallbackEntry {
  family_id: string;
  model_id: string;
}

interface LlmFormState {
  family_id: string;
  model_id: string;
  custom_family_id: string;
  custom_model_id: string;
  base_url: string;
  system_prompt: string;
  max_output_tokens: string;
  max_history: string;
  max_iterations: string;
  max_concurrent_sessions: string;
  browser_timeout_secs: string;
  fallbacks: FallbackEntry[];
  adaptive_routing_enabled: boolean;
}

type TestStatus = "idle" | "testing" | "connected" | "failed";

/* ─── Helpers ─── */

function resolveProviderFromProfile(familyId: string): LlmProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.id === familyId);
}

function profileToForm(profile: Profile): LlmFormState {
  const familyId = profile.config.llm.primary.family_id ?? "";
  const knownProvider = resolveProviderFromProfile(familyId);
  const primaryRoute = profile.config.llm.primary.route;

  const rawRouting = profile.config.adaptive_routing;
  const adaptiveEnabled =
    rawRouting != null &&
    typeof rawRouting === "object" &&
    (rawRouting as Record<string, unknown>).enabled === true;

  return {
    family_id: knownProvider ? familyId : familyId ? "__custom_family__" : "",
    model_id: knownProvider ? (profile.config.llm.primary.model_id ?? "") : "",
    custom_family_id: knownProvider ? "" : familyId,
    custom_model_id: knownProvider ? "" : (profile.config.llm.primary.model_id ?? ""),
    base_url: primaryRoute?.base_url ?? knownProvider?.defaultBaseUrl ?? "",
    system_prompt: profile.config.gateway.system_prompt ?? "",
    max_output_tokens:
      profile.config.gateway.max_output_tokens != null
        ? String(profile.config.gateway.max_output_tokens)
        : "",
    max_history:
      profile.config.gateway.max_history != null
        ? String(profile.config.gateway.max_history)
        : "",
    max_iterations:
      profile.config.gateway.max_iterations != null
        ? String(profile.config.gateway.max_iterations)
        : "",
    max_concurrent_sessions:
      profile.config.gateway.max_concurrent_sessions != null
        ? String(profile.config.gateway.max_concurrent_sessions)
        : "",
    browser_timeout_secs:
      profile.config.gateway.browser_timeout_secs != null
        ? String(profile.config.gateway.browser_timeout_secs)
        : "",
    fallbacks: Array.isArray(profile.config.llm.fallbacks)
      ? profile.config.llm.fallbacks.map((f: LlmPrimary) => ({
          family_id: f.family_id ?? "",
          model_id: f.model_id ?? "",
        }))
      : [],
    adaptive_routing_enabled: adaptiveEnabled,
  };
}

function optionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

/* ─── Shared UI atoms ─── */

const inputClass =
  "w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition";
const selectClass =
  "w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text outline-none border border-transparent focus:border-accent/30 transition appearance-none cursor-pointer";
const labelClass = "mb-1.5 block text-xs font-medium text-muted";

/* ─── Component ─── */

export function LlmTab({ profile, onProfileUpdated }: LlmTabProps) {
  const [form, setForm] = useState<LlmFormState>(() => profileToForm(profile));
  const [original, setOriginal] = useState<LlmFormState>(() =>
    profileToForm(profile),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);
  const isCustom = form.family_id === "__custom_family__";
  const selectedProvider = isCustom ? undefined : findProvider(form.family_id);
  const providerModels = selectedProvider?.models ?? [];
  const needsBaseUrl = selectedProvider
    ? showsBaseUrl(selectedProvider)
    : isCustom;

  /* ── Derived effective IDs (what we send to API) ── */
  const effectiveFamilyId = isCustom
    ? form.custom_family_id
    : form.family_id;
  const effectiveModelId = isCustom
    ? form.custom_model_id
    : form.model_id === "__custom__"
      ? form.custom_model_id
      : form.model_id;

  /* ── Provider change ── */
  const handleProviderChange = (newFamilyId: string) => {
    const provider = findProvider(newFamilyId);
    setForm((f) => ({
      ...f,
      family_id: newFamilyId,
      model_id: provider?.models[0]?.id ?? "",
      custom_family_id: "",
      custom_model_id: "",
      base_url: provider?.defaultBaseUrl ?? "",
    }));
    setTestStatus("idle");
  };

  /* ── Test Connection ── */
  const handleTestConnection = async () => {
    if (!effectiveFamilyId || !effectiveModelId) return;
    setTestStatus("testing");
    setTestMessage(null);
    try {
      const envKey = selectedProvider?.envKey || "";
      const baseUrl = needsBaseUrl
        ? form.base_url.trim()
        : selectedProvider?.defaultBaseUrl;
      const resp = await request<{ ok: boolean; message?: string; error?: string }>("/api/my/test-provider", {
        method: "POST",
        body: JSON.stringify({
          provider: effectiveFamilyId,
          model: effectiveModelId,
          api_key_env: envKey || undefined,
          api_key: envKey ? undefined : "not-required",
          base_url: baseUrl || undefined,
          profile_id: profile.id,
        }),
      });
      if (resp.ok) {
        setTestStatus("connected");
        setTestMessage(resp.message || "Connected");
      } else {
        setTestStatus("failed");
        setTestMessage(resp.error || resp.message || "Connection failed");
      }
    } catch {
      setTestStatus("failed");
      setTestMessage("Connection test endpoint unavailable");
    }
    setTimeout(() => {
      setTestStatus("idle");
      setTestMessage(null);
    }, 4000);
  };

  /* ── Save ── */
  const handleSave = async () => {
    setSaving(true);
    setError(null);

    const fallbacksPayload: LlmPrimary[] = form.fallbacks
      .filter((f) => f.family_id.trim())
      .map((f) => ({ family_id: f.family_id.trim(), model_id: f.model_id.trim() }));
    const primaryRoute = {
      api_key_env: selectedProvider?.envKey || null,
      base_url: needsBaseUrl ? form.base_url.trim() || null : null,
    };

    try {
      const result = await updateMyProfile({
        config: {
          llm: {
            primary: {
              family_id: effectiveFamilyId,
              model_id: effectiveModelId,
              route: primaryRoute.api_key_env || primaryRoute.base_url ? primaryRoute : null,
            },
            fallbacks: fallbacksPayload,
          },
          gateway: {
            ...profile.config.gateway,
            system_prompt: form.system_prompt.trim() || null,
            max_output_tokens: optionalInt(form.max_output_tokens),
            max_history: optionalInt(form.max_history),
            max_iterations: optionalInt(form.max_iterations),
            max_concurrent_sessions: optionalInt(form.max_concurrent_sessions),
            browser_timeout_secs: optionalInt(form.browser_timeout_secs),
          },
          adaptive_routing: { enabled: form.adaptive_routing_enabled },
        },
      });
      onProfileUpdated(result);
      const newForm = profileToForm(result);
      setForm(newForm);
      setOriginal(newForm);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(formatSettingsError(err, "Failed to update LLM config."));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setForm({ ...original });
    setTestStatus("idle");
  };

  return (
    <div className="space-y-6">
      {/* ── Model Selection ── */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Cpu size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              LLM Configuration
            </h3>
            <p className="text-xs text-muted">
              Select a provider and model for this profile
            </p>
          </div>
        </div>

        <div className="space-y-5">
          {/* Provider Family */}
          <div>
            <label className={labelClass}>Provider</label>
            <select
              value={form.family_id}
              onChange={(e) => handleProviderChange(e.target.value)}
              className={selectClass}
            >
              <option value="">Select a provider...</option>
              {LLM_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Custom provider ID (only when Custom selected) */}
          {isCustom && (
            <div>
              <label className={labelClass}>Custom Provider ID</label>
              <input
                type="text"
                value={form.custom_family_id}
                onChange={(e) =>
                  setForm((f) => ({ ...f, custom_family_id: e.target.value }))
                }
                placeholder="e.g. my-provider"
                className={inputClass}
              />
            </div>
          )}

          {/* Model selector (when provider has models) */}
          {!isCustom && providerModels.length > 0 && (
            <div>
              <label className={labelClass}>Model</label>
              <select
                value={form.model_id}
                onChange={(e) =>
                  setForm((f) => ({ ...f, model_id: e.target.value }))
                }
                className={selectClass}
              >
                {providerModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
                <option value="__custom__">Custom model...</option>
              </select>
            </div>
          )}

          {/* Custom model input (custom provider, empty model list, or "Custom model..." chosen) */}
          {(isCustom ||
            (selectedProvider && providerModels.length === 0) ||
            form.model_id === "__custom__") && (
            <div>
              <label className={labelClass}>
                {isCustom || providerModels.length === 0
                  ? "Model ID"
                  : "Custom Model ID"}
              </label>
              <input
                type="text"
                value={form.custom_model_id}
                onChange={(e) =>
                  setForm((f) => ({ ...f, custom_model_id: e.target.value }))
                }
                placeholder="e.g. my-model-v2"
                className={inputClass}
              />
            </div>
          )}

          {/* Env key hint */}
          {selectedProvider?.envKey && (
            <div className="flex items-start gap-2 rounded-xl bg-surface-dark/50 px-4 py-3">
              <AlertCircle
                size={14}
                className="mt-0.5 shrink-0 text-amber-400"
              />
              <span className="text-xs text-muted">
                Requires{" "}
                <code className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-[11px] text-text">
                  {selectedProvider.envKey}
                </code>{" "}
                in Environment Variables
              </span>
            </div>
          )}

          {/* Base URL (ollama / vllm / custom) */}
          {needsBaseUrl && (
            <div>
              <label className={labelClass}>Base URL</label>
              <input
                type="text"
                value={form.base_url}
                onChange={(e) =>
                  setForm((f) => ({ ...f, base_url: e.target.value }))
                }
                placeholder={
                  selectedProvider?.defaultBaseUrl ?? "https://api.example.com"
                }
                className={inputClass}
              />
            </div>
          )}

          {/* Test Connection */}
          {form.family_id && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleTestConnection}
                disabled={testStatus === "testing" || !effectiveFamilyId}
                className="flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-muted hover:text-text-strong hover:border-accent/30 disabled:opacity-30 transition"
              >
                {testStatus === "testing" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Plug size={14} />
                )}
                {testStatus === "testing" ? "Testing..." : "Test Connection"}
              </button>
              {testStatus === "connected" && (
                <span className="flex items-center gap-1.5 text-xs font-medium text-green-400">
                  <CheckCircle2 size={14} />
                  {testMessage || "Connected"}
                </span>
              )}
              {testStatus === "failed" && (
                <span className="flex items-center gap-1.5 text-xs font-medium text-red-400">
                  <XCircle size={14} />
                  {testMessage || "Connection failed"}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Fallback Models ── */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Shuffle size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              Fallback Models
            </h3>
            <p className="text-xs text-muted">
              Ordered list of fallback providers tried if the primary fails
            </p>
          </div>
        </div>

        <div className="space-y-3">
          {form.fallbacks.length === 0 && (
            <p className="text-xs text-muted py-2">
              No fallbacks configured. Add one below.
            </p>
          )}

          {form.fallbacks.map((entry, idx) => {
            const fbProvider = findProvider(entry.family_id);
            const fbModels = fbProvider?.models ?? [];
            return (
              <div
                key={idx}
                className="flex items-start gap-2 rounded-xl bg-surface-container p-3"
              >
                {/* Order badge */}
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-dark text-xs font-semibold text-muted mt-0.5">
                  {idx + 1}
                </span>

                {/* Provider + Model selects */}
                <div className="flex flex-1 flex-col gap-2 sm:flex-row">
                  <select
                    value={entry.family_id}
                    onChange={(e) => {
                      const newFamilyId = e.target.value;
                      const newProvider = findProvider(newFamilyId);
                      setForm((f) => {
                        const updated = [...f.fallbacks];
                        updated[idx] = {
                          family_id: newFamilyId,
                          model_id: newProvider?.models[0]?.id ?? "",
                        };
                        return { ...f, fallbacks: updated };
                      });
                    }}
                    className={selectClass}
                  >
                    <option value="">Select provider...</option>
                    {LLM_PROVIDERS.filter(
                      (p) => p.id !== "__custom_family__",
                    ).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>

                  {fbModels.length > 0 ? (
                    <select
                      value={entry.model_id}
                      onChange={(e) =>
                        setForm((f) => {
                          const updated = [...f.fallbacks];
                          updated[idx] = {
                            ...updated[idx],
                            model_id: e.target.value,
                          };
                          return { ...f, fallbacks: updated };
                        })
                      }
                      className={selectClass}
                    >
                      {fbModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={entry.model_id}
                      onChange={(e) =>
                        setForm((f) => {
                          const updated = [...f.fallbacks];
                          updated[idx] = {
                            ...updated[idx],
                            model_id: e.target.value,
                          };
                          return { ...f, fallbacks: updated };
                        })
                      }
                      placeholder="Model ID..."
                      className={inputClass}
                    />
                  )}
                </div>

                {/* Reorder + remove buttons */}
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    onClick={() =>
                      setForm((f) => {
                        if (idx === 0) return f;
                        const updated = [...f.fallbacks];
                        [updated[idx - 1], updated[idx]] = [
                          updated[idx],
                          updated[idx - 1],
                        ];
                        return { ...f, fallbacks: updated };
                      })
                    }
                    disabled={idx === 0}
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-muted hover:text-text-strong hover:border-accent/30 disabled:opacity-20 transition"
                    title="Move up"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    onClick={() =>
                      setForm((f) => {
                        if (idx === f.fallbacks.length - 1) return f;
                        const updated = [...f.fallbacks];
                        [updated[idx], updated[idx + 1]] = [
                          updated[idx + 1],
                          updated[idx],
                        ];
                        return { ...f, fallbacks: updated };
                      })
                    }
                    disabled={idx === form.fallbacks.length - 1}
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-muted hover:text-text-strong hover:border-accent/30 disabled:opacity-20 transition"
                    title="Move down"
                  >
                    <ChevronDown size={13} />
                  </button>
                </div>

                <button
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      fallbacks: f.fallbacks.filter((_, i) => i !== idx),
                    }))
                  }
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border text-muted hover:text-red-400 hover:border-red-400/30 transition mt-0.5"
                  title="Remove fallback"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}

          <button
            onClick={() =>
              setForm((f) => ({
                ...f,
                fallbacks: [
                  ...f.fallbacks,
                  { family_id: "", model_id: "" },
                ],
              }))
            }
            className="flex items-center gap-2 rounded-xl border border-dashed border-border px-4 py-2.5 text-sm text-muted hover:text-text-strong hover:border-accent/30 transition w-full justify-center"
          >
            <Plus size={14} />
            Add Fallback
          </button>
        </div>
      </div>

      {/* ── Adaptive Routing ── */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Settings2 size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              Adaptive Routing
            </h3>
            <p className="text-xs text-muted">
              Automatically route between primary and fallbacks based on latency and error rates
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Toggle row */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-text">Enable adaptive routing</span>
            <button
              role="switch"
              aria-checked={form.adaptive_routing_enabled}
              onClick={() =>
                setForm((f) => ({
                  ...f,
                  adaptive_routing_enabled: !f.adaptive_routing_enabled,
                }))
              }
              className={[
                "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none",
                form.adaptive_routing_enabled ? "bg-accent" : "bg-surface-dark",
              ].join(" ")}
            >
              <span
                className={[
                  "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
                  form.adaptive_routing_enabled
                    ? "translate-x-5"
                    : "translate-x-0",
                ].join(" ")}
              />
            </button>
          </div>

          {/* Info panel (shown when enabled) */}
          {form.adaptive_routing_enabled && (
            <div className="flex items-start gap-3 rounded-xl bg-accent/5 border border-accent/20 px-4 py-3">
              <Info size={14} className="mt-0.5 shrink-0 text-accent" />
              <div className="space-y-1">
                <p className="text-xs font-medium text-text-strong">
                  How adaptive routing works
                </p>
                <ul className="list-disc list-inside space-y-0.5 text-xs text-muted">
                  <li>Tracks p50/p95 latency per model over a rolling window</li>
                  <li>Automatically shifts traffic away from slow or erroring models</li>
                  <li>Primary model is preferred when healthy; fallbacks are tried in order</li>
                  <li>No manual intervention needed — weights adjust in real time</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Prompt & Output ── */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Settings2 size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              Prompt & Output
            </h3>
            <p className="text-xs text-muted">
              System prompt and output token limit
            </p>
          </div>
        </div>

        <div className="space-y-5">
          {/* System prompt */}
          <div>
            <label className={labelClass}>System Prompt</label>
            <textarea
              value={form.system_prompt}
              onChange={(e) =>
                setForm((f) => ({ ...f, system_prompt: e.target.value }))
              }
              placeholder="Optional system prompt override..."
              rows={4}
              className="w-full resize-y rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
            />
          </div>

          {/* Max Output Tokens */}
          <div>
            <label className={labelClass}>Max Output Tokens</label>
            <input
              type="number"
              min={256}
              max={128000}
              step={256}
              value={form.max_output_tokens}
              onChange={(e) =>
                setForm((f) => ({ ...f, max_output_tokens: e.target.value }))
              }
              placeholder="Leave empty for default"
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* ── Gateway Advanced ── */}
      <div className="glass-section rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Settings2 size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">
              Gateway Parameters
            </h3>
            <p className="text-xs text-muted">
              Advanced session and iteration limits
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Max History */}
          <div>
            <label className={labelClass}>Max History</label>
            <input
              type="number"
              min={1}
              max={200}
              value={form.max_history}
              onChange={(e) =>
                setForm((f) => ({ ...f, max_history: e.target.value }))
              }
              placeholder="Default"
              className={inputClass}
            />
          </div>

          {/* Max Iterations */}
          <div>
            <label className={labelClass}>Max Iterations</label>
            <input
              type="number"
              min={1}
              max={100}
              value={form.max_iterations}
              onChange={(e) =>
                setForm((f) => ({ ...f, max_iterations: e.target.value }))
              }
              placeholder="Default"
              className={inputClass}
            />
          </div>

          {/* Max Concurrent Sessions */}
          <div>
            <label className={labelClass}>Max Concurrent Sessions</label>
            <input
              type="number"
              min={1}
              max={50}
              value={form.max_concurrent_sessions}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  max_concurrent_sessions: e.target.value,
                }))
              }
              placeholder="Default"
              className={inputClass}
            />
          </div>

          {/* Browser Timeout */}
          <div>
            <label className={labelClass}>Browser Timeout (seconds)</label>
            <input
              type="number"
              min={5}
              max={600}
              value={form.browser_timeout_secs}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  browser_timeout_secs: e.target.value,
                }))
              }
              placeholder="Default"
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* ── Actions ── */}
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
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
