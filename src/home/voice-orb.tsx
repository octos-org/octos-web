/**
 * Voice Orb — a circular glassmorphism button that serves as the primary
 * voice-interaction entry point on the standby view.
 *
 * States drive visual appearance via CSS `data-state` attribute:
 * - idle:       soft breathing glow
 * - listening:  green glow, faster pulse
 * - processing: purple spinning indicator
 * - speaking:   amber pulsing glow
 *
 * Pure CSS animations — Canvas version deferred to PR 4.
 */

import { Mic } from "lucide-react";

export type OrbState = "idle" | "listening" | "processing" | "speaking";

export interface VoiceOrbProps {
  state: OrbState;
  onClick: () => void;
  disabled?: boolean;
}

export function VoiceOrb({ state, onClick, disabled }: VoiceOrbProps) {
  return (
    <button
      className="home-voice-orb"
      data-state={state}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      disabled={disabled}
      aria-label={
        state === "idle"
          ? "Tap to speak"
          : state === "listening"
            ? "Listening..."
            : state === "processing"
              ? "Processing..."
              : "Speaking..."
      }
      type="button"
    >
      <Mic
        size={32}
        className={`home-voice-orb-icon ${
          state === "listening"
            ? "text-emerald-400"
            : state === "processing"
              ? "text-purple-400"
              : state === "speaking"
                ? "text-amber-400"
                : "text-white/60"
        } transition-colors duration-300`}
      />
    </button>
  );
}
