/**
 * Voice Orb — re-exports AuroraOrb (Canvas-based aurora effect).
 *
 * This module keeps the public API (`VoiceOrb`, `OrbState`, `VoiceOrbProps`)
 * so that existing imports from standby-view / use-voice-input stay valid.
 */

export type OrbState = "idle" | "listening" | "processing" | "speaking";

export interface VoiceOrbProps {
  state: OrbState;
  onClick: () => void;
  disabled?: boolean;
}

export { AuroraOrb as VoiceOrb } from "./aurora-orb";
