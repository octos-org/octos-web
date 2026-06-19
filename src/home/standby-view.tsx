import { ClassicStandbyView } from "./classic-standby-view";
import { useHomeSettings } from "./home-settings-context";
import { MetroTileGrid } from "./metro-tiles";
import type { WakeWordStatusView } from "./voice/use-wake-word-listener";

interface StandbyViewProps {
  onActivate: (prefill?: string) => void;
  onMusicToggle: () => void;
  musicPlaying: boolean;
  nightActive: boolean;
  wakeWordStatus?: WakeWordStatusView;
}

export function StandbyView({
  onActivate,
  onMusicToggle,
  musicPlaying,
  nightActive,
  wakeWordStatus,
}: StandbyViewProps) {
  const { uiStyle } = useHomeSettings();
  if (uiStyle === "classic") {
    return (
      <ClassicStandbyView
        onActivate={onActivate}
        onMusicToggle={onMusicToggle}
        musicPlaying={musicPlaying}
        nightActive={nightActive}
        wakeWordStatus={wakeWordStatus}
      />
    );
  }
  return (
    <MetroTileGrid
      onActivate={onActivate}
      onMusicToggle={onMusicToggle}
      musicPlaying={musicPlaying}
      nightActive={nightActive}
      wakeWordStatus={wakeWordStatus}
    />
  );
}
