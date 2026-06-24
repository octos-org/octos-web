/**
 * VoiceSelector — a quick reply-voice (TTS timbre) switcher shown at the bottom
 * of the voice conversation screen. Drives the server-backed `voice-store`.
 */
import { useEffect, useState } from "react";
import { loadVoices, selectVoice, useVoiceStore } from "@/store/voice-store";
import { getMyProfile } from "@/settings/settings-api";
import type { VoiceInfo } from "@/api/voice";

function labelFor(v: VoiceInfo): string {
  return v.aliases[0] ?? v.id;
}

export function VoiceSelector() {
  const { voices, current, status } = useVoiceStore();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // These pills switch the ON-DEVICE reply voice (timbre). When the cloud
  // (Volcano) route is selected they have no effect — the cloud voice is set
  // in Settings → Voice — so hide the whole switcher. `auto`/`local` keep it
  // (auto may still resolve to on-device).
  const [cloudRoute, setCloudRoute] = useState(false);

  useEffect(() => {
    if (status === "idle") void loadVoices();
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    getMyProfile()
      .then((p) => {
        if (cancelled) return;
        const route = p?.config.tts_provider;
        setCloudRoute(route === "cloud" || route === "volcano");
      })
      .catch(() => {
        /* keep the switcher visible if the profile can't be read */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(id: string) {
    if (busy || id === current) return;
    setBusy(true);
    setFailed(false);
    try {
      await selectVoice(id); // store reverts `current` on failure
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (cloudRoute || voices.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="flex flex-wrap justify-center gap-2"
        role="listbox"
        aria-label="voice"
      >
        {voices.map((v) => (
          <button
            key={v.id}
            type="button"
            role="option"
            aria-selected={v.id === current}
            disabled={busy}
            onClick={() => pick(v.id)}
            className={`rounded-full px-3 py-1 text-sm transition-colors disabled:opacity-40 ${
              v.id === current
                ? "bg-accent/25 text-accent"
                : "bg-white/5 text-white/55 hover:bg-white/10 hover:text-white/80"
            }`}
          >
            {labelFor(v)}
          </button>
        ))}
      </div>
      {failed && <p className="text-xs text-red-400">切换失败，已恢复原音色</p>}
    </div>
  );
}
