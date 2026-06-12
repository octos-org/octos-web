import { MetroTileGrid } from "./metro-tiles";

interface StandbyViewProps {
  onActivate: (prefill?: string) => void;
  nightActive: boolean;
}

export function StandbyView({ onActivate, nightActive }: StandbyViewProps) {
  return <MetroTileGrid onActivate={onActivate} nightActive={nightActive} />;
}
