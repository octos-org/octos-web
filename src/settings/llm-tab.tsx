import { useState } from "react";
import { Cpu, Save, Loader2, Check, RotateCcw } from "lucide-react";
import { updateMyProfile, type Profile } from "./settings-api";

interface LlmTabProps {
  profile: Profile;
  onProfileUpdated: (p: Profile) => void;
}

interface LlmFormState {
  family_id: string;
  model_id: string;
  system_prompt: string;
  max_output_tokens: string; // string for input binding, empty = null
}

function profileToForm(profile: Profile): LlmFormState {
  return {
    family_id: profile.config.llm.primary.family_id ?? "",
    model_id: profile.config.llm.primary.model_id ?? "",
    system_prompt: profile.config.gateway.system_prompt ?? "",
    max_output_tokens:
      profile.config.gateway.max_output_tokens != null
        ? String(profile.config.gateway.max_output_tokens)
        : "",
  };
}

export function LlmTab({ profile, onProfileUpdated }: LlmTabProps) {
  const [form, setForm] = useState<LlmFormState>(() => profileToForm(profile));
  const [original, setOriginal] = useState<LlmFormState>(() => profileToForm(profile));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty = JSON.stringify(form) !== JSON.stringify(original);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    const maxTokens = form.max_output_tokens.trim()
      ? parseInt(form.max_output_tokens, 10) || null
      : null;

    const result = await updateMyProfile({
      config: {
        llm: {
          primary: { family_id: form.family_id, model_id: form.model_id },
          fallbacks: profile.config.llm.fallbacks,
        },
        gateway: {
          ...profile.config.gateway,
          system_prompt: form.system_prompt.trim() || null,
          max_output_tokens: maxTokens,
        },
      },
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
      setError("Failed to update LLM config.");
    }
  };

  const handleReset = () => {
    setForm({ ...original });
  };

  return (
    <div className="space-y-6">
      <div className="glass-section rounded-2xl p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Cpu size={20} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-strong">LLM Configuration</h3>
            <p className="text-xs text-muted">Configure the language model for this profile</p>
          </div>
        </div>

        <div className="space-y-5">
          {/* Provider / Family ID */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Provider (family_id)
            </label>
            <input
              type="text"
              value={form.family_id}
              onChange={(e) => setForm((f) => ({ ...f, family_id: e.target.value }))}
              placeholder="e.g. openai, anthropic, deepseek"
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
            />
          </div>

          {/* Model ID */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Model
            </label>
            <input
              type="text"
              value={form.model_id}
              onChange={(e) => setForm((f) => ({ ...f, model_id: e.target.value }))}
              placeholder="e.g. gpt-5.5, claude-sonnet-4-20250514"
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
            />
          </div>

          {/* Max Output Tokens */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Max Output Tokens
            </label>
            <input
              type="number"
              min={256}
              max={128000}
              step={256}
              value={form.max_output_tokens}
              onChange={(e) => setForm((f) => ({ ...f, max_output_tokens: e.target.value }))}
              placeholder="Leave empty for default"
              className="w-full rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
            />
          </div>

          {/* System prompt */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              System Prompt
            </label>
            <textarea
              value={form.system_prompt}
              onChange={(e) => setForm((f) => ({ ...f, system_prompt: e.target.value }))}
              placeholder="Optional system prompt override..."
              rows={4}
              className="w-full resize-y rounded-xl bg-surface-container px-4 py-3 text-sm text-text placeholder-muted/50 outline-none border border-transparent focus:border-accent/30 transition"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="mt-6 flex items-center gap-3">
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
    </div>
  );
}
