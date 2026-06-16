import { ClassicStandbyView } from "./classic-standby-view";
import { useHomeSettings } from "./home-settings-context";
import { MetroTileGrid } from "./metro-tiles";

interface StandbyViewProps {
  onActivate: (prefill?: string) => void;
  onMusicToggle: () => void;
  musicPlaying: boolean;
  nightActive: boolean;
}

export function StandbyView({
  onActivate,
  onMusicToggle,
  musicPlaying,
  nightActive,
}: StandbyViewProps) {
  const { uiStyle } = useHomeSettings();
  if (uiStyle === "classic") {
    return (
      <ClassicStandbyView
        onActivate={onActivate}
        onMusicToggle={onMusicToggle}
        musicPlaying={musicPlaying}
        nightActive={nightActive}
      />
    );
  }
  return (
    <MetroTileGrid
      onActivate={onActivate}
      onMusicToggle={onMusicToggle}
      musicPlaying={musicPlaying}
      nightActive={nightActive}
    />
  );
}
