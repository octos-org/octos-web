/**
 * Home Assistant UI constants — all user-visible strings live here.
 *
 * No string is hardcoded in JSX. If i18n is ever wired in, swap
 * these exports for a `t()` call.
 */

export const HOME_STRINGS = {
  weekdays: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ] as const,
  months: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ] as const,

  // Quick-action card labels
  cardChat: "Chat",
  cardNews: "News",
  cardMusic: "Music",
  cardHome: "Home",

  // Misc
  backToStandby: "Back",
  send: "Send",
  inputPlaceholder: "Say something...",
  weatherUnavailable: "Weather unavailable",
  locationUnavailable: "Location unavailable",

  // Idle return
  idleReturnSeconds: 30,
} as const;

// Open-Meteo WMO weather code → emoji + label
// https://open-meteo.com/en/docs  §WMO Weather interpretation codes
export const WMO_WEATHER: Record<
  number,
  { emoji: string; label: string }
> = {
  0: { emoji: "\u2600\uFE0F", label: "Clear sky" },
  1: { emoji: "\u{1F324}\uFE0F", label: "Mainly clear" },
  2: { emoji: "\u26C5", label: "Partly cloudy" },
  3: { emoji: "\u2601\uFE0F", label: "Overcast" },
  45: { emoji: "\u{1F32B}\uFE0F", label: "Fog" },
  48: { emoji: "\u{1F32B}\uFE0F", label: "Rime fog" },
  51: { emoji: "\u{1F326}\uFE0F", label: "Light drizzle" },
  53: { emoji: "\u{1F326}\uFE0F", label: "Drizzle" },
  55: { emoji: "\u{1F326}\uFE0F", label: "Dense drizzle" },
  61: { emoji: "\u{1F327}\uFE0F", label: "Light rain" },
  63: { emoji: "\u{1F327}\uFE0F", label: "Rain" },
  65: { emoji: "\u{1F327}\uFE0F", label: "Heavy rain" },
  66: { emoji: "\u{1F327}\uFE0F", label: "Freezing rain" },
  67: { emoji: "\u{1F327}\uFE0F", label: "Heavy freezing rain" },
  71: { emoji: "\u{1F328}\uFE0F", label: "Light snow" },
  73: { emoji: "\u{1F328}\uFE0F", label: "Snow" },
  75: { emoji: "\u{1F328}\uFE0F", label: "Heavy snow" },
  77: { emoji: "\u{1F328}\uFE0F", label: "Snow grains" },
  80: { emoji: "\u{1F326}\uFE0F", label: "Light showers" },
  81: { emoji: "\u{1F326}\uFE0F", label: "Showers" },
  82: { emoji: "\u{1F326}\uFE0F", label: "Violent showers" },
  85: { emoji: "\u{1F328}\uFE0F", label: "Snow showers" },
  86: { emoji: "\u{1F328}\uFE0F", label: "Heavy snow showers" },
  95: { emoji: "\u26C8\uFE0F", label: "Thunderstorm" },
  96: { emoji: "\u26C8\uFE0F", label: "Thunderstorm with hail" },
  99: { emoji: "\u26C8\uFE0F", label: "Heavy thunderstorm" },
};
