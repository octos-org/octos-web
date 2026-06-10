/**
 * Home Assistant UI constants — all user-visible strings live here.
 *
 * No string is hardcoded in JSX. If i18n is ever wired in, swap
 * these exports for a `t()` call.
 *
 * HOME_I18N provides per-language string tables; the active language
 * is selected via the settings context (`lang` field).
 */

export interface HomeStrings {
  weekdays: readonly string[];
  months: readonly string[];

  // Quick-action card labels
  cardChat: string;
  cardNews: string;
  cardMusic: string;
  cardHome: string;

  // Quick-action card prefills (empty string = no prefill)
  cardChatPrefill: string;
  cardNewsPrefill: string;
  cardMusicPrefill: string;
  cardHomePrefill: string;

  // Greetings (time-of-day)
  greetingMorning: string;
  greetingAfternoon: string;
  greetingEvening: string;
  greetingNight: string;

  // Misc
  backToStandby: string;
  send: string;
  inputPlaceholder: string;
  weatherUnavailable: string;
  locationUnavailable: string;

  // Idle return
  idleReturnSeconds: number;

  // Settings panel
  settingsTitle: string;
  settingsCity: string;
  settingsCityPlaceholder: string;
  settingsTempUnit: string;
  settingsClockFormat: string;
  settingsIdleSeconds: string;
  settingsNightMode: string;
  settingsNightAuto: string;
  settingsNightOn: string;
  settingsNightOff: string;
  settingsLanguage: string;
  settingsClose: string;

  // Voice
  voiceListening: string;
  voiceNotSupported: string;
  voiceError: string;

  // Widget labels
  widgetClock: string;
  widgetWeather: string;
  widgetQuickActions: string;
  widgetVoiceOrb: string;
  widgetGreeting: string;
  widgetNews: string;
  widgetCalendar: string;
  widgetTimer: string;
  widgetPhotoFrame: string;
  settingsWidgets: string;

  // Photo frame
  settingsPhotos: string;
  settingsAddPhoto: string;
  settingsPhotoPlaceholder: string;

  // News widget
  newsHeadlines: string;

  // Calendar widget
  calendarToday: string;
  calendarNoEvents: string;

  // Settings — News & Events
  settingsNewsFeed: string;
  settingsEvents: string;
  settingsAddEvent: string;

  // Suggestion prompts
  suggestions: readonly string[];
}

export const HOME_I18N: Record<string, HomeStrings> = {
  en: {
    weekdays: [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ],
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
    ],

    cardChat: "Chat",
    cardNews: "News",
    cardMusic: "Music",
    cardHome: "Home",

    cardChatPrefill: "",
    cardNewsPrefill: "What's the latest news today?",
    cardMusicPrefill: "Play some music for me",
    cardHomePrefill: "What's the status of my home devices?",

    greetingMorning: "Good morning",
    greetingAfternoon: "Good afternoon",
    greetingEvening: "Good evening",
    greetingNight: "Good night",

    backToStandby: "Back",
    send: "Send",
    inputPlaceholder: "Say something...",
    weatherUnavailable: "Weather unavailable",
    locationUnavailable: "Location unavailable",

    idleReturnSeconds: 30,

    settingsTitle: "Settings",
    settingsCity: "Default City",
    settingsCityPlaceholder: "e.g. San Francisco",
    settingsTempUnit: "Temperature",
    settingsClockFormat: "Clock Format",
    settingsIdleSeconds: "Idle Return (seconds)",
    settingsNightMode: "Night Mode",
    settingsNightAuto: "Auto",
    settingsNightOn: "On",
    settingsNightOff: "Off",
    settingsLanguage: "Language",
    settingsClose: "Close",

    voiceListening: "Listening...",
    voiceNotSupported: "Voice not supported",
    voiceError: "Voice error",

    widgetClock: "Clock",
    widgetWeather: "Weather",
    widgetQuickActions: "Quick Actions",
    widgetVoiceOrb: "Voice",
    widgetGreeting: "Greeting",
    widgetNews: "News",
    widgetCalendar: "Calendar",
    widgetTimer: "Timer",
    widgetPhotoFrame: "Photos",
    settingsWidgets: "Widgets",

    settingsPhotos: "Photo Frame",
    settingsAddPhoto: "Add Photo URL",
    settingsPhotoPlaceholder: "https://example.com/photo.jpg",

    newsHeadlines: "Headlines",

    calendarToday: "Today",
    calendarNoEvents: "No events today",

    settingsNewsFeed: "News Feed URL",
    settingsEvents: "Events",
    settingsAddEvent: "Add Event",

    suggestions: [
      "What's the weather like today?",
      "Tell me today's top news",
      "Set a timer for 5 minutes",
      "What can you help me with?",
    ],
  },

  zh: {
    weekdays: [
      "\u661F\u671F\u65E5",
      "\u661F\u671F\u4E00",
      "\u661F\u671F\u4E8C",
      "\u661F\u671F\u4E09",
      "\u661F\u671F\u56DB",
      "\u661F\u671F\u4E94",
      "\u661F\u671F\u516D",
    ],
    months: [
      "\u4E00\u6708",
      "\u4E8C\u6708",
      "\u4E09\u6708",
      "\u56DB\u6708",
      "\u4E94\u6708",
      "\u516D\u6708",
      "\u4E03\u6708",
      "\u516B\u6708",
      "\u4E5D\u6708",
      "\u5341\u6708",
      "\u5341\u4E00\u6708",
      "\u5341\u4E8C\u6708",
    ],

    cardChat: "\u804A\u5929",
    cardNews: "\u65B0\u95FB",
    cardMusic: "\u97F3\u4E50",
    cardHome: "\u9996\u9875",

    cardChatPrefill: "",
    cardNewsPrefill: "\u4ECA\u5929\u6709\u4EC0\u4E48\u65B0\u95FB\uFF1F",
    cardMusicPrefill: "\u7ED9\u6211\u64AD\u653E\u97F3\u4E50",
    cardHomePrefill: "\u6211\u7684\u5BB6\u5C45\u8BBE\u5907\u72B6\u6001\u5982\u4F55\uFF1F",

    greetingMorning: "\u65E9\u4E0A\u597D",
    greetingAfternoon: "\u4E0B\u5348\u597D",
    greetingEvening: "\u665A\u4E0A\u597D",
    greetingNight: "\u665A\u5B89",

    backToStandby: "\u8FD4\u56DE",
    send: "\u53D1\u9001",
    inputPlaceholder: "\u8BF4\u70B9\u4EC0\u4E48...",
    weatherUnavailable: "\u5929\u6C14\u4FE1\u606F\u4E0D\u53EF\u7528",
    locationUnavailable: "\u4F4D\u7F6E\u4FE1\u606F\u4E0D\u53EF\u7528",

    idleReturnSeconds: 30,

    settingsTitle: "\u8BBE\u7F6E",
    settingsCity: "\u9ED8\u8BA4\u57CE\u5E02",
    settingsCityPlaceholder: "\u4F8B\u5982 \u5317\u4EAC",
    settingsTempUnit: "\u6E29\u5EA6\u5355\u4F4D",
    settingsClockFormat: "\u65F6\u949F\u683C\u5F0F",
    settingsIdleSeconds: "\u7A7A\u95F2\u8FD4\u56DE (\u79D2)",
    settingsNightMode: "\u591C\u95F4\u6A21\u5F0F",
    settingsNightAuto: "\u81EA\u52A8",
    settingsNightOn: "\u5F00\u542F",
    settingsNightOff: "\u5173\u95ED",
    settingsLanguage: "\u8BED\u8A00",
    settingsClose: "\u5173\u95ED",

    voiceListening: "\u6B63\u5728\u542C...",
    voiceNotSupported: "\u8BED\u97F3\u4E0D\u652F\u6301",
    voiceError: "\u8BED\u97F3\u9519\u8BEF",

    widgetClock: "\u65F6\u949F",
    widgetWeather: "\u5929\u6C14",
    widgetQuickActions: "\u5FEB\u6377\u64CD\u4F5C",
    widgetVoiceOrb: "\u8BED\u97F3",
    widgetGreeting: "\u95EE\u5019",
    widgetNews: "\u65B0\u95FB",
    widgetCalendar: "\u65E5\u5386",
    widgetTimer: "\u8BA1\u65F6\u5668",
    widgetPhotoFrame: "\u76F8\u518C",
    settingsWidgets: "\u7EC4\u4EF6",

    settingsPhotos: "\u7167\u7247\u76F8\u6846",
    settingsAddPhoto: "\u6DFB\u52A0\u7167\u7247\u94FE\u63A5",
    settingsPhotoPlaceholder: "https://example.com/photo.jpg",

    newsHeadlines: "\u5934\u6761",

    calendarToday: "\u4ECA\u5929",
    calendarNoEvents: "\u4ECA\u5929\u6CA1\u6709\u65E5\u7A0B",

    settingsNewsFeed: "\u65B0\u95FB\u6E90",
    settingsEvents: "\u65E5\u7A0B",
    settingsAddEvent: "\u6DFB\u52A0\u65E5\u7A0B",

    suggestions: [
      "\u4ECA\u5929\u5929\u6C14\u600E\u4E48\u6837\uFF1F",
      "\u7ED9\u6211\u8BB2\u8BB2\u4ECA\u5929\u7684\u65B0\u95FB",
      "\u8BBE\u4E2A5\u5206\u949F\u5012\u8BA1\u65F6",
      "\u4F60\u80FD\u5E2E\u6211\u505A\u4EC0\u4E48\uFF1F",
    ],
  },
} as const;

/** Fallback location used when both geolocation and IP-based lookup fail. */
export const DEFAULT_LOCATION = {
  lat: 37.7749,
  lon: -122.4194,
  city: "San Francisco",
} as const;

export const HOME_STRINGS = HOME_I18N.en;

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
