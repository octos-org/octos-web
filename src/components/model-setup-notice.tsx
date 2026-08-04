/**
 * Proactive "no model configured" notice for the chat surface.
 *
 * First-run solo profiles have no LLM selection, so their very first chat
 * message used to be how they found out — a doomed send answered by a raw
 * `rpc-error[-32603] No ProfileRuntime registered…`. The backend gate is
 * knowable up front (`ProfileConfig::has_llm_selection`), and the runtime
 * lazily bootstraps on the next send once a selection is saved, so this
 * banner can warn before the fact and clear itself when the user comes
 * back from Settings.
 */

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getMyProfile, type Profile } from "@/settings/settings-api";

/** Mirrors the backend's `ProfileConfig::has_llm_selection` gate
 *  (octos-cli `profiles.rs`): the chat runtime lazily bootstraps only when
 *  the primary LLM selection is non-empty.
 *
 *  Deliberately does NOT inspect credentials: a key supplied via the host
 *  process env never appears in `config.env_vars`, so demanding a stored
 *  key here would false-alarm on every host-env self-hosted setup. The
 *  selection-missing case is the one the backend reports with the
 *  "No ProfileRuntime registered" error this notice prevents. */
export function isModelConfigured(profile: Profile): boolean {
  const primary = profile.config?.llm?.primary;
  return Boolean(primary?.family_id?.trim() || primary?.model_id?.trim());
}

const LLM_SETTINGS_HREF = "/settings?tab=llm";

export function ModelSetupNotice(): React.ReactElement | null {
  const [unconfigured, setUnconfigured] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const profile = await getMyProfile();
        // Unknown state (null profile, older backend, network blip) stays
        // silent — a false alarm on a working setup is worse than no banner.
        if (active) setUnconfigured(profile ? !isModelConfigured(profile) : false);
      } catch {
        // same: stay silent
      }
    }
    check();
    // Re-check on focus so "open Settings → save a provider → come back"
    // clears the notice without a reload.
    window.addEventListener("focus", check);
    return () => {
      active = false;
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!unconfigured || dismissed) return null;

  return (
    <div
      data-testid="model-setup-notice"
      role="status"
      className="mx-4 mb-2 flex shrink-0 items-center gap-2 rounded-[10px] border border-(--workbench-warning-border) bg-(--workbench-warning-bg) px-3 py-2 text-xs text-(--workbench-warning-text)"
    >
      <span className="min-w-0 flex-1">
        No model is set up yet — your messages can&apos;t be answered until you
        add a provider and API key.
      </span>
      {/* Plain anchor, same reasoning as GhostBubble's setup link: leaving
          the page is safe, session state reloads from the server. */}
      <a
        data-testid="model-setup-notice-link"
        href={LLM_SETTINGS_HREF}
        className="shrink-0 rounded-md border border-(--workbench-warning-border) px-2 py-1 font-medium hover:underline"
      >
        Set up a model
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
