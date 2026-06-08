/**
 * Standby view — large clock, weather, quick-action cards.
 *
 * Designed for small touch-screen displays (800x480 / 1280x800) at
 * arm's-length (>1m). High-contrast text on a deep-dark background.
 */

import { useCallback } from "react";
import { MessageSquare, Newspaper, Music, Home } from "lucide-react";
import { useClock } from "./use-clock";
import { useWeather } from "./use-weather";
import { HOME_STRINGS } from "./constants";

interface StandbyViewProps {
  onActivate: () => void;
}

const QUICK_ACTIONS = [
  { id: "chat", icon: MessageSquare, label: HOME_STRINGS.cardChat, color: "text-blue-400" },
  { id: "news", icon: Newspaper, label: HOME_STRINGS.cardNews, color: "text-amber-400" },
  { id: "music", icon: Music, label: HOME_STRINGS.cardMusic, color: "text-emerald-400" },
  { id: "home", icon: Home, label: HOME_STRINGS.cardHome, color: "text-purple-400" },
] as const;

export function StandbyView({ onActivate }: StandbyViewProps) {
  const clock = useClock();
  const weather = useWeather();

  const dateStr = `${HOME_STRINGS.weekdays[clock.date.getDay()]}, ${HOME_STRINGS.months[clock.date.getMonth()]} ${clock.date.getDate()}`;

  const handleClick = useCallback(() => {
    onActivate();
  }, [onActivate]);

  return (
    <div
      className="home-standby flex h-full w-full flex-col items-center justify-center select-none cursor-pointer"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onActivate();
      }}
    >
      {/* Weather strip */}
      <div className="home-weather-strip mb-4 flex items-center gap-3">
        {weather.loading ? (
          <div className="h-6 w-24 animate-pulse rounded-full bg-white/10" />
        ) : weather.error ? (
          <span className="text-lg text-white/40">
            {HOME_STRINGS.weatherUnavailable}
          </span>
        ) : (
          <>
            <span className="text-3xl leading-none">{weather.emoji}</span>
            <span className="text-2xl font-medium tabular-nums text-white/90">
              {weather.temperature}&deg;C
            </span>
            <span className="text-lg text-white/50">{weather.label}</span>
          </>
        )}
      </div>

      {/* Clock */}
      <div className="home-clock tabular-nums text-white" aria-live="polite">
        <span>{clock.hours}</span>
        <span className="home-clock-colon">:</span>
        <span>{clock.minutes}</span>
      </div>

      {/* Date */}
      <div className="home-date mt-2 text-white/50">{dateStr}</div>

      {/* Quick actions */}
      <div className="home-quick-actions mt-10 flex gap-4">
        {QUICK_ACTIONS.map(({ id, icon: Icon, label, color }) => (
          <button
            key={id}
            onClick={(e) => {
              e.stopPropagation();
              onActivate();
            }}
            className="home-quick-card group flex flex-col items-center justify-center gap-2"
            aria-label={label}
          >
            <div className="home-quick-card-icon flex items-center justify-center rounded-2xl">
              <Icon size={28} className={`${color} transition-transform group-hover:scale-110`} />
            </div>
            <span className="text-sm font-medium text-white/60 group-hover:text-white/90 transition-colors">
              {label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
