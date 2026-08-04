/**
 * Proactive "model not usable yet" notice for the chat surface.
 *
 * First-run solo profiles have no LLM selection, so their very first chat
 * message used to be how they found out — a doomed send answered by a raw
 * `rpc-error[-32603] No ProfileRuntime registered…`. The follow-up tier is
 * just as deadly: a saved provider/model whose API key was never entered
 * makes the send HANG (no terminal error ever arrives — the ghost just
 * times out after 30s). Both states are knowable up front from the profile
 * config, so this banner warns before the fact and clears itself once the
 * user finishes setup (the runtime lazily bootstraps on the next send).
 */

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getMyProfile, type Profile } from "@/settings/settings-api";
import { findProvider } from "@/settings/llm-providers";

export type ModelSetupState = "ready" | "no-selection" | "key-missing";

/** Classify whether the profile's primary LLM can actually answer a chat.
 *
 *  Two gates, mirroring what the backend hits in order:
 *  1. `has_llm_selection` (octos-cli `profiles.rs`) — no selection means the
 *     chat runtime refuses to bootstrap ("No ProfileRuntime registered").
 *  2. Credential presence — a keyed provider without its env var fails
 *     provider construction at lazy-bootstrap time. env_vars values arrive
 *     masked but PRESENT, so presence of the key is enough; we never see
 *     the secret itself. This mirrors the API Keys tab's own "Not set"
 *     semantics. Known edge: a key supplied via the host process env is
 *     invisible here (false "key-missing") — the notice is dismissible,
 *     and the API Keys tab already reports "Not set" for that case too. */
export function modelSetupState(profile: Profile): ModelSetupState {
  const primary = profile.config?.llm?.primary;
  if (!primary?.family_id?.trim() && !primary?.model_id?.trim()) {
    return "no-selection";
  }
  const provider = findProvider(primary.family_id);
  const envKey = primary.route?.api_key_env || provider?.envKey;
  // Unknown family (custom provider) or a keyless one (ollama/vllm):
  // nothing more we can verify — assume ready.
  if (!envKey) return "ready";
  const stored = profile.config?.env_vars?.[envKey];
  return typeof stored === "string" && stored.length > 0
    ? "ready"
    : "key-missing";
}

/** Back-compat boolean view: the model can answer messages. */
export function isModelConfigured(profile: Profile): boolean {
  return modelSetupState(profile) === "ready";
}

const LLM_SETTINGS_HREF = "/settings?tab=llm";
const API_KEYS_SETTINGS_HREF = "/settings?tab=api-keys";

const COPY: Record<
  Exclude<ModelSetupState, "ready">,
  { message: string; action: string; href: string }
> = {
  "no-selection": {
    message:
      "No model is set up yet — your messages can't be answered until you add a provider and API key.",
    action: "Set up a model",
    href: LLM_SETTINGS_HREF,
  },
  "key-missing": {
    message:
      "Your model needs an API key before messages can be answered.",
    action: "Add API key",
    href: API_KEYS_SETTINGS_HREF,
  },
};

export function ModelSetupNotice(): React.ReactElement | null {
  const [state, setState] = useState<ModelSetupState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const profile = await getMyProfile();
        // Unknown state (null profile, older backend, network blip) stays
        // silent — a false alarm on a working setup is worse than no banner.
        if (active) setState(profile ? modelSetupState(profile) : null);
      } catch {
        // same: stay silent
      }
    }
    check();
    // Re-check on focus so "open Settings → save → come back" clears the
    // notice without a reload.
    window.addEventListener("focus", check);
    return () => {
      active = false;
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!state || state === "ready" || dismissed) return null;
  const copy = COPY[state];

  return (
    <div
      data-testid="model-setup-notice"
      data-setup-state={state}
      role="status"
      className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-[10px] border border-(--workbench-warning-border) bg-(--workbench-warning-bg) px-3 py-2 text-xs text-(--workbench-warning-text)"
    >
      <span className="min-w-0 flex-1">{copy.message}</span>
      {/* Plain anchor, same reasoning as GhostBubble's setup link: leaving
          the page is safe, session state reloads from the server. */}
      <a
        data-testid="model-setup-notice-link"
        href={copy.href}
        className="shrink-0 rounded-md border border-(--workbench-warning-border) px-2 py-1 font-medium hover:underline"
      >
        {copy.action}
      </a>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded-md p-1 hover:bg-(--workbench-warning-border)"
      >
        <X size={14} />
      </button>
    </div>
  );
}
