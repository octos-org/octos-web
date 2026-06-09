/**
 * Standby view — large clock, weather, quick-action cards.
 *
 * Designed for small touch-screen displays (800x480 / 1280x800) at
 * arm's-length (>1m). High-contrast text on a deep-dark background.
 *
 * Enhanced with:
 * - Settings gear button (top-right)
 * - Burn-in protection (periodic micro-shift + idle dim)
 * - Night mode support (hides cards/weather, dims display)
 * - i18n via settings context
 */

import { useCallback, useState } from "react";
import { MessageSquare, Newspaper, Music, Home } from "lucide-react";
import { useClock } from "./use-clock";
import { useWeather } from "./use-weather";
import { useHomeSettings } from "./home-settings-context";
import { useBurnInProtection } from "./use-burn-in-protection";
import { SettingsGearButton, HomeSettingsPanel } from "./home-settings";

interface StandbyViewProps {
  onActivate: () => void;
  nightActive: boolean;
}

export function StandbyView({ onActivate, nightActive }: StandbyViewProps) {
  const clock = useClock();
  const weather = useWeather();
  const { strings, tempUnit, clockFormat } = useHomeSettings();
  const burnIn = useBurnInProtection();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const dateStr = `${strings.weekdays[clock.date.getDay()]}, ${strings.months[clock.date.getMonth()]} ${clock.date.getDate()}`;

  // Format hours according to clock format setting
  const displayHours = (() => {
    const h = clock.date.getHours();
    if (clockFormat === "12h") {
      const h12 = h % 12 || 12;
      return String(h12).padStart(2, "0");
    }
    return clock.hours;
  })();

  const ampm = clockFormat === "12h"
    ? clock.date.getHours() >= 12 ? "PM" : "AM"
    : null;

  // Format temperature according to unit setting
  const displayTemp = (() => {
    if (tempUnit === "F") {
      return Math.round(weather.temperature * 9 / 5 + 32);
    }
    return weather.temperature;
  })();

  const QUICK_ACTIONS = [
    { id: "chat", icon: MessageSquare, label: strings.cardChat, color: "text-blue-400" },
    { id: "news", icon: Newspaper, label: strings.cardNews, color: "text-amber-400" },
    { id: "music", icon: Music, label: strings.cardMusic, color: "text-emerald-400" },
    { id: "home", icon: Home, label: strings.cardHome, color: "text-purple-400" },
  ] as const;

  const handleClick = useCallback(() => {
    if (!settingsOpen) onActivate();
  }, [onActivate, settingsOpen]);

  return (
    <div
      className={`home-standby flex h-full w-full flex-col items-center justify-center select-none cursor-pointer ${
        burnIn.dimmed ? "home-dimmed" : ""
      }`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onActivate();
      }}
      onMouseMove={() => burnIn.onActivity()}
      onTouchStart={() => burnIn.onActivity()}
    >
      {/* Settings gear */}
      <SettingsGearButton onClick={() => setSettingsOpen(true)} />

      {/* Weather strip — hidden in night mode */}
      {!nightActive && (
        <div className="home-weather-strip mb-4 flex items-center gap-3">
          {weather.loading ? (
            <div className="h-6 w-24 animate-pulse rounded-full bg-white/10" />
          ) : weather.error ? (
            <span className="text-lg text-white/40">
              {strings.weatherUnavailable}
            </span>
          ) : (
            <>
              <span className="text-3xl leading-none">{weather.emoji}</span>
              <span className="text-2xl font-medium tabular-nums text-white/90">
                {displayTemp}&deg;{tempUnit}
              </span>
              <span className="text-lg text-white/50">{weather.label}</span>
              {weather.city && (
                <span className="text-lg text-white/40">&middot; {weather.city}</span>
              )}
            </>
          )}
        </div>
      )}

      {/* Clock — shifted by burn-in protection */}
      <div
        className={`home-clock tabular-nums ${nightActive ? "home-clock-night" : "text-white"}`}
        aria-live="polite"
        style={{
          transform: `translate(${burnIn.offset.x}px, ${burnIn.offset.y}px)`,
          transition: "transform 2s ease-in-out",
        }}
      >
        <span>{displayHours}</span>
        <span className="home-clock-colon">:</span>
        <span>{clock.minutes}</span>
        {ampm && (
          <span className="home-clock-ampm ml-3 text-[0.3em] font-normal text-white/40">
            {ampm}
          </span>
        )}
      </div>

      {/* Date — shifted with clock */}
      <div
        className="home-date mt-2 text-white/50"
        style={{
          transform: `translate(${burnIn.offset.x}px, ${burnIn.offset.y}px)`,
          transition: "transform 2s ease-in-out",
        }}
      >
        {dateStr}
      </div>

      {/* Quick actions — hidden in night mode */}
      {!nightActive && (
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
      )}

      {/* Settings panel */}
      <HomeSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
