import { useCallback, useMemo, useState } from "react";
import {
  CalendarDays,
  Home,
  MessageSquare,
  Music,
  Newspaper,
} from "lucide-react";

import { SettingsGearButton, HomeSettingsPanel } from "./home-settings";
import { useBurnInProtection } from "./use-burn-in-protection";
import { useClock } from "./use-clock";
import { useEvents } from "./use-events";
import { useHomeSettings } from "./home-settings-context";
import { useNews, timeAgo } from "./use-news";
import { PhotoFrame } from "./photo-frame";
import { SmartHomePanel } from "./smart-home";
import { TimerWidget } from "./timer-widget";
import { useVoiceInput } from "./use-voice-input";
import { useWeather } from "./use-weather";
import { VoiceOrb } from "./voice-orb";
import type { WidgetConfig, WidgetType } from "./widget-registry";

interface ClassicStandbyViewProps {
  onActivate: (prefill?: string) => void;
  onMusicToggle: () => void;
  musicPlaying: boolean;
  nightActive: boolean;
}

function isWidgetOn(widgets: WidgetConfig[], type: WidgetType): boolean {
  const widget = widgets.find((entry) => entry.type === type);
  return widget ? widget.enabled : true;
}

export function ClassicStandbyView({
  onActivate,
  onMusicToggle,
  musicPlaying,
  nightActive,
}: ClassicStandbyViewProps) {
  const clock = useClock();
  const weather = useWeather();
  const { strings, tempUnit, clockFormat, widgets, newsFeedUrl, lang, burnInProtection } =
    useHomeSettings();
  const burnIn = useBurnInProtection(burnInProtection);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const news = useNews(newsFeedUrl);
  const events = useEvents();

  const voice = useVoiceInput({
    onResult: (text) => onActivate(text),
    lang: lang === "zh" ? "zh-CN" : "en-US",
  });

  const handleOrbClick = useCallback(() => {
    if (!voice.isSupported) {
      onActivate("");
      return;
    }
    if (voice.orbState === "listening") {
      voice.stop();
    } else if (voice.orbState === "idle") {
      voice.start();
    }
  }, [voice, onActivate]);

  const dateStr = `${strings.weekdays[clock.date.getDay()]}, ${
    strings.months[clock.date.getMonth()]
  } ${clock.date.getDate()}`;

  const greeting = useMemo(() => {
    const hour = clock.date.getHours();
    if (hour >= 5 && hour < 12) return strings.greetingMorning;
    if (hour >= 12 && hour < 17) return strings.greetingAfternoon;
    if (hour >= 17 && hour < 21) return strings.greetingEvening;
    return strings.greetingNight;
  }, [clock.date, strings]);

  const displayHours = (() => {
    const hour = clock.date.getHours();
    if (clockFormat === "12h") return String(hour % 12 || 12).padStart(2, "0");
    return clock.hours;
  })();

  const ampm =
    clockFormat === "12h" ? (clock.date.getHours() >= 12 ? "PM" : "AM") : null;

  const formatTemp = useCallback(
    (tempC: number) =>
      tempUnit === "F" ? Math.round((tempC * 9) / 5 + 32) : tempC,
    [tempUnit],
  );

  const quickActions = [
    {
      id: "chat",
      icon: MessageSquare,
      label: strings.cardChat,
      color: "text-blue-400",
      prefill: strings.cardChatPrefill,
    },
    {
      id: "news",
      icon: Newspaper,
      label: strings.cardNews,
      color: "text-amber-400",
      prefill: strings.cardNewsPrefill,
    },
    {
      id: "music",
      icon: Music,
      label: musicPlaying ? strings.cardMusicOff : strings.cardMusicOn,
      color: "text-emerald-400",
      prefill: "",
    },
    {
      id: "home",
      icon: Home,
      label: strings.cardHome,
      color: "text-purple-400",
      prefill: strings.cardHomePrefill,
    },
  ] as const;

  return (
    <div
      className={`classic-home-standby home-standby h-full w-full select-none overflow-y-auto px-5 pb-6 pt-20 ${
        burnIn.dimmed ? "home-dimmed" : ""
      }`}
      onMouseMove={() => burnIn.onActivity()}
      onTouchStart={() => burnIn.onActivity()}
    >
      <div className="home-top-bar absolute left-0 right-0 top-0 z-20 flex items-center justify-between px-6 pt-5">
        {!nightActive && isWidgetOn(widgets, "greeting") ? (
          <span className="home-greeting home-greeting-fadein text-2xl font-light text-white/40">
            {greeting}
          </span>
        ) : (
          <span />
        )}
        <SettingsGearButton onClick={() => setSettingsOpen(true)} />
      </div>

      <div className="classic-home-grid">
        {isWidgetOn(widgets, "clock") && (
          <section
            className="classic-home-clock-panel home-widget"
            aria-live="polite"
            style={{
              transform: `translate(${burnIn.offset.x}px, ${burnIn.offset.y}px)`,
              transition: "transform 2s ease-in-out",
            }}
          >
            <div
              className={`home-clock tabular-nums ${
                nightActive ? "home-clock-night" : "text-white"
              }`}
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

            <div className="home-date mt-2 text-white/50">{dateStr}</div>

            {isWidgetOn(widgets, "voice-orb") && (
              <div className="classic-home-voice-panel">
                <VoiceOrb state={voice.orbState} onClick={handleOrbClick} />
                {voice.orbState === "listening" && voice.transcript && (
                  <p className="mt-2 max-w-[200px] truncate text-center text-sm text-white/40">
                {voice.transcript}
              </p>
            )}
            {(!voice.isSupported || voice.error) && (
              <p className="mt-2 max-w-[220px] text-center text-xs text-white/35">
                {voice.error ?? strings.voiceNotSupported}
              </p>
            )}
          </div>
        )}
          </section>
        )}

        {isWidgetOn(widgets, "weather") && (
          <section className="home-widget home-weather-widget classic-home-weather-panel px-5 py-4">
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
                <div className="home-weather-current flex shrink-0 items-center gap-3">
                  <span className="text-4xl leading-none">{weather.emoji}</span>
                  <div className="flex flex-col">
                    <span className="text-3xl font-semibold leading-tight tabular-nums text-white/95">
                      {formatTemp(weather.temperature)}&deg;{tempUnit}
                    </span>
                    <span className="mt-0.5 text-sm leading-tight text-white/50">
                      {weather.label}
                      {weather.city && <span> &middot; {weather.city}</span>}
                    </span>
                  </div>
                </div>

                {weather.hourly.length > 0 && (
                  <div className="home-weather-divider h-12 w-px shrink-0 bg-white/10" />
                )}

                {weather.hourly.length > 0 && (
                  <div className="home-forecast-strip flex gap-4 overflow-x-auto">
                    {weather.hourly.map((item, index) => (
                      <div
                        key={`${item.hour}-${index}`}
                        className="home-forecast-item flex shrink-0 flex-col items-center gap-1"
                      >
                        <span className="text-xs tabular-nums text-white/40">
                          {item.hour}
                        </span>
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
          </section>
        )}

        {isWidgetOn(widgets, "quick-actions") && (
          <div className="home-quick-actions classic-home-quick-panel">
            {quickActions.map(({ id, icon: Icon, label, color, prefill }) => (
              <button
                key={id}
                onClick={() => {
                  if (id === "music") {
                    onMusicToggle();
                    return;
                  }
                  onActivate(prefill || undefined);
                }}
                className="home-quick-card group flex flex-col items-center justify-center gap-2"
                aria-label={label}
              >
                <div className="home-quick-card-icon flex items-center justify-center rounded-2xl">
                  <Icon
                    size={28}
                    className={`${color} transition-transform group-hover:scale-110`}
                  />
                </div>
                <span className="text-sm font-medium text-white/60 transition-colors group-hover:text-white/90">
                  {label}
                </span>
              </button>
            ))}
          </div>
        )}

        {isWidgetOn(widgets, "smart-home") && (
          <section className="classic-home-smart-panel">
            <SmartHomePanel variant="classic" />
          </section>
        )}

        {isWidgetOn(widgets, "news") && (
          <section className="home-widget home-news-widget classic-home-news-panel px-5 py-4">
            <div className="mb-3 flex items-center gap-2">
              <Newspaper size={16} className="text-amber-400/70" />
              <span className="text-sm font-medium text-white/50">
                {strings.newsHeadlines}
              </span>
            </div>

            {news.loading && news.items.length === 0 ? (
              <div className="flex gap-4 overflow-hidden">
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="home-news-card shrink-0 animate-pulse"
                  >
                    <div className="mb-2 h-4 w-36 rounded bg-white/10" />
                    <div className="h-3 w-20 rounded bg-white/5" />
                  </div>
                ))}
              </div>
            ) : news.error ? (
              <span className="text-sm text-white/30">{news.error}</span>
            ) : (
              <div className="home-news-strip flex gap-3 overflow-x-auto pb-1">
                {news.items.map((item, index) => (
                  <button
                    key={`${item.link}-${index}`}
                    className="home-news-card shrink-0"
                    onClick={() => onActivate(`Tell me more about: ${item.title}`)}
                    aria-label={item.title}
                  >
                    <p className="home-news-title text-sm font-medium leading-snug text-white/80">
                      {item.title}
                    </p>
                    <span className="mt-auto pt-1 text-xs text-white/30">
                      {timeAgo(item.pubDate)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {isWidgetOn(widgets, "calendar") && (
          <section className="home-widget home-calendar-widget classic-home-calendar-panel px-5 py-4">
            <div className="mb-3 flex items-center gap-2">
              <CalendarDays size={16} className="text-blue-400/70" />
              <span className="text-sm font-medium text-white/50">
                {strings.calendarToday}
              </span>
            </div>

            {events.todayEvents.length === 0 ? (
              <span className="text-sm text-white/25">
                {strings.calendarNoEvents}
              </span>
            ) : (
              <div className="home-calendar-list max-h-[180px] space-y-1.5 overflow-y-auto">
                {events.todayEvents.slice(0, 4).map((event) => {
                  const [eventHour, eventMinute] = event.time.split(":").map(Number);
                  const eventMinutes = eventHour * 60 + eventMinute;
                  const nowMinutes =
                    clock.date.getHours() * 60 + clock.date.getMinutes();
                  const isUpcoming =
                    eventMinutes >= nowMinutes && eventMinutes - nowMinutes <= 120;
                  const isPast = eventMinutes < nowMinutes;

                  return (
                    <div
                      key={event.id}
                      className={`home-event-item flex items-center gap-3 rounded-lg px-3 py-2 ${
                        isUpcoming
                          ? "border border-blue-500/20 bg-blue-500/10"
                          : isPast
                            ? "opacity-40"
                            : "bg-white/[0.03]"
                      }`}
                    >
                      <span className="shrink-0 text-sm font-medium tabular-nums text-white/50">
                        {event.time}
                      </span>
                      <span className="truncate text-sm text-white/75">
                        {event.title}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {isWidgetOn(widgets, "timer") && (
          <div className="classic-home-widget-slot classic-home-timer-panel">
            <TimerWidget />
          </div>
        )}

        {isWidgetOn(widgets, "photo-frame") && (
          <div className="classic-home-widget-slot classic-home-photo-panel">
            <PhotoFrame />
          </div>
        )}
      </div>

      <HomeSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
