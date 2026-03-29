import type { TileConfig } from "../constants";

export function GenerationTile({
  config,
  onClick,
  disabled,
}: {
  config: TileConfig;
  onClick: () => void;
  disabled?: boolean;
}) {
  const Icon = config.icon;

  return (
    <button
      onClick={onClick}
      disabled={disabled || !config.available}
      className={`group relative flex flex-col items-center gap-2 rounded-2xl p-4 text-center transition-all ${
        config.available
          ? "bg-surface-container hover:bg-surface-elevated hover:elevation-2 cursor-pointer"
          : "bg-surface-container/50 cursor-not-allowed opacity-50"
      } ${disabled ? "opacity-50 pointer-events-none" : ""}`}
    >
      <div className={`${config.color}`}>
        <Icon size={28} strokeWidth={1.5} />
      </div>
      <span className="text-xs font-medium text-text-strong">{config.label}</span>
      <span className="text-[10px] leading-tight text-muted/70">{config.description}</span>
      {!config.available && (
        <span className="absolute right-2 top-2 rounded-md bg-muted/20 px-1.5 py-0.5 text-[9px] text-muted">
          Soon
        </span>
      )}
    </button>
  );
}
