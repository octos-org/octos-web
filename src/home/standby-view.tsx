import { ClassicStandbyView } from "./classic-standby-view";
import { useHomeSettings } from "./home-settings-context";
import { MetroTileGrid } from "./metro-tiles";

interface StandbyViewProps {
  onActivate: (prefill?: string) => void;
  nightActive: boolean;
}

export function StandbyView({ onActivate, nightActive }: StandbyViewProps) {
  const { uiStyle } = useHomeSettings();
  if (uiStyle === "classic") {
    return (
      <ClassicStandbyView onActivate={onActivate} nightActive={nightActive} />
    );
  }
  return <MetroTileGrid onActivate={onActivate} nightActive={nightActive} />;
}
