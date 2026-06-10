/**
 * Standby view — large clock, weather widget, quick-action cards.
 *
 * Designed for small touch-screen displays (800x480 / 1280x800) at
 * arm's-length (>1m). High-contrast text on a deep-dark background.
 *
 * Enhanced with:
 * - Settings gear button (top-right)
 * - Greeting text (top-left, time-of-day aware)
 * - Weather widget card with 6-hour forecast strip
 * - Glassmorphism widget cards
 * - Burn-in protection (periodic micro-shift + idle dim)
 * - Night mode support (hides cards/weather, dims display)
 * - i18n via settings context
 */

import { useCallback, useMemo, useState } from "react";
import { MessageSquare, Newspaper, Music, Home } from "lucide-react";
import { useClock } from "./use-clock";
import { useWeather } from "./use-weather";
import { useHomeSettings } from "./home-settings-context";
import { useBurnInProtection } from "./use-burn-in-protection";
import { SettingsGearButton, HomeSettingsPanel } from "./home-settings";

interface StandbyViewProps {
  onActivate: (prefill?: string) => void;
  nightActive: boolean;
}

export function StandbyView({ onActivate, nightActive }: StandbyViewProps) {
  const clock = useClock();
  const weather = useWeather();
  const { strings, tempUnit, clockFormat } = useHomeSettings();
  const burnIn = useBurnInProtection();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const dateStr = `${strings.weekdays[clock.date.getDay()]}, ${strings.months[clock.date.getMonth()]} ${clock.date.getDate()}`;

  // Greeting based on time of day
  const greeting = useMemo(() => {
    const h = clock.date.getHours();
    if (h >= 5 && h < 12) return strings.greetingMorning;
    if (h >= 12 && h < 17) return strings.greetingAfternoon;
    if (h >= 17 && h < 21) return strings.greetingEvening;
    return strings.greetingNight;
  }, [clock.date, strings]);

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
  const formatTemp = useCallback((tempC: number) => {
    if (tempUnit === "F") {
      return Math.round(tempC * 9 / 5 + 32);
    }
    return tempC;
  }, [tempUnit]);

  const displayTemp = formatTemp(weather.temperature);

  const QUICK_ACTIONS = [
    { id: "chat", icon: MessageSquare, label: strings.cardChat, color: "text-blue-400", prefill: strings.cardChatPrefill },
    { id: "news", icon: Newspaper, label: strings.cardNews, color: "text-amber-400", prefill: strings.cardNewsPrefill },
    { id: "music", icon: Music, label: strings.cardMusic, color: "text-emerald-400", prefill: strings.cardMusicPrefill },
    { id: "home", icon: Home, label: strings.cardHome, color: "text-purple-400", prefill: strings.cardHomePrefill },
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
      {/* Top bar: greeting (left) + settings gear (right) */}
      <div className="home-top-bar absolute top-0 left-0 right-0 flex items-center justify-between px-6 pt-5 z-20">
        {!nightActive && (
          <span className="home-greeting text-2xl font-light text-white/40">
            {greeting}
          </span>
        )}
        {nightActive && <span />}
        <SettingsGearButton onClick={() => setSettingsOpen(true)} />
      </div>

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

      {/* Weather widget card — hidden in night mode */}
      {!nightActive && (
        <div className="home-widget home-weather-widget mt-8 mx-4 px-6 py-4">
          {weather.loading ? (
            <div className="flex items-center gap-3">
              <div className="h-10 w-20 animate-pulse rounded-xl bg-white/10" />
              <div className="h-6 w-40 animate-pulse rounded-lg bg-white/10" />
            </div>
          ) : weather.error ? (
            <span className="text-lg text-white/40">
              {strings.weatherUnavailable}
            </span>
          ) : (
            <div className="home-weather-layout flex items-center gap-6">
              {/* Current conditions — left side */}
              <div className="home-weather-current flex items-center gap-3 shrink-0">
                <span className="text-4xl leading-none">{weather.emoji}</span>
                <div className="flex flex-col">
                  <span className="text-3xl font-semibold tabular-nums text-white/95 leading-tight">
                    {displayTemp}&deg;{tempUnit}
                  </span>
                  <span className="text-sm text-white/50 leading-tight mt-0.5">
                    {weather.label}
                    {weather.city && <span> &middot; {weather.city}</span>}
                  </span>
                </div>
              </div>

              {/* Divider */}
              {weather.hourly.length > 0 && (
                <div className="home-weather-divider w-px h-12 bg-white/10 shrink-0" />
              )}

              {/* Hourly forecast strip — right side */}
              {weather.hourly.length > 0 && (
                <div className="home-forecast-strip flex gap-4 overflow-x-auto">
                  {weather.hourly.map((item, i) => (
                    <div key={i} className="home-forecast-item flex flex-col items-center gap-1 shrink-0">
                      <span className="text-xs text-white/40 tabular-nums">{item.hour}</span>
                      <span className="text-lg leading-none">{item.emoji}</span>
                      <span className="text-sm font-medium tabular-nums text-white/70">
                        {formatTemp(item.temp)}&deg;
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Quick actions — hidden in night mode */}
      {!nightActive && (
        <div className="home-quick-actions mt-8">
          {QUICK_ACTIONS.map(({ id, icon: Icon, label, color, prefill }) => (
            <button
              key={id}
              onClick={(e) => {
                e.stopPropagation();
                onActivate(prefill || undefined);
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
