import type { VoiceState } from "./use-voice-conversation";

export function VoiceOrb({ state }: { state: VoiceState }) {
  return (
    <div className={`voice-orb is-${state}`} aria-hidden>
      <span className="voice-orb-ring r1" />
      <span className="voice-orb-ring r2" />
      <span className="voice-orb-core" />
    </div>
  );
}
