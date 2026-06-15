/**
 * Home Settings Context.
 *
 * Profile config is the canonical store. The legacy localStorage keys remain
 * as migration/offline cache so existing Home dashboards keep their data.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getMyProfile,
  updateMyProfileConfig,
  type HomeProfileConfig,
  type Profile,
} from "@/settings/settings-api";
import { HOME_I18N, type HomeStrings } from "./constants";
import {
  DEFAULT_WIDGETS,
  readWidgets,
  writeWidgets,
  type WidgetConfig,
  type WidgetType,
} from "./widget-registry";

export type TempUnit = "C" | "F";
export type ClockFormat = "12h" | "24h";
export type NightMode = "auto" | "on" | "off";
export type Lang = "en" | "zh";
export type HomeUiStyle = "metro" | "classic";

export interface HomeSettings {
  city: string;
  tempUnit: TempUnit;
  clockFormat: ClockFormat;
  idleSeconds: number;
  nightMode: NightMode;
  burnInProtection: boolean;
  lang: Lang;
  newsFeedUrl: string;
  calendarFeedUrl: string;
  uiStyle: HomeUiStyle;
}

export interface CalendarEvent {
  id: string;
  title: string;
  /** "HH:MM" */
  time: string;
  /** "YYYY-MM-DD" */
  date: string;
  recurring?: "daily" | "weekly";
}

export interface TileLayout {
  col: number;
  row: number;
  w: number;
  h: number;
}

interface HomeData {
  settings: HomeSettings;
  widgets: WidgetConfig[];
  events: CalendarEvent[];
  photos: string[];
  metroLayout: Record<string, TileLayout>;
}

export interface HomeSettingsContextValue extends HomeSettings {
  strings: HomeStrings;
  update: (patch: Partial<HomeSettings>) => void;
  widgets: WidgetConfig[];
  setWidgets: (widgets: WidgetConfig[]) => void;
  toggleWidget: (type: WidgetType) => void;
  moveWidget: (type: WidgetType, direction: "up" | "down") => void;
  events: CalendarEvent[];
  addEvent: (event: Omit<CalendarEvent, "id">) => void;
  removeEvent: (id: string) => void;
  photos: string[];
  addPhoto: (url: string) => void;
  removePhoto: (url: string) => void;
  metroLayout: Record<string, TileLayout>;
  setMetroLayout: (layouts: Record<string, TileLayout>) => void;
  profileBacked: boolean;
}

export const DEFAULT_FEED_URL = "https://feeds.bbci.co.uk/news/rss.xml";

const SETTINGS_KEYS = {
  city: "octos_home_city",
  tempUnit: "octos_home_temp_unit",
  clockFormat: "octos_home_clock_format",
  idleSeconds: "octos_home_idle_seconds",
  nightMode: "octos_home_night_mode",
  burnInProtection: "octos_home_burn_in_protection",
  lang: "octos_home_lang",
  newsFeedUrl: "octos_home_news_feed_url",
  calendarFeedUrl: "octos_home_calendar_feed_url",
  uiStyle: "octos_home_ui_style",
} as const;

const EVENTS_KEY = "octos_home_events";
const PHOTOS_KEY = "octos_home_photos";
const METRO_LAYOUT_KEY = "octos_home_metro_layout";

const DEFAULT_SETTINGS: HomeSettings = {
  city: "",
  tempUnit: "C",
  clockFormat: "24h",
  idleSeconds: 30,
  nightMode: "auto",
  burnInProtection: false,
  lang: "en",
  newsFeedUrl: DEFAULT_FEED_URL,
  calendarFeedUrl: "",
  uiStyle: "metro",
};

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Offline cache best-effort only.
  }
}

function clampIdle(n: number): number {
  return Math.max(10, Math.min(300, Math.round(n)));
}

function asTempUnit(value: unknown, fallback: TempUnit): TempUnit {
  return value === "C" || value === "F" ? value : fallback;
}

function asClockFormat(value: unknown, fallback: ClockFormat): ClockFormat {
  return value === "12h" || value === "24h" ? value : fallback;
}

function asNightMode(value: unknown, fallback: NightMode): NightMode {
  return value === "auto" || value === "on" || value === "off" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return fallback;
}

function asLang(value: unknown, fallback: Lang): Lang {
  return value === "en" || value === "zh" ? value : fallback;
}

function asHomeUiStyle(value: unknown, fallback: HomeUiStyle): HomeUiStyle {
  return value === "metro" || value === "classic" ? value : fallback;
}

function readLegacySettings(): HomeSettings {
  return {
    city: storageGet(SETTINGS_KEYS.city) ?? DEFAULT_SETTINGS.city,
    tempUnit: asTempUnit(storageGet(SETTINGS_KEYS.tempUnit), DEFAULT_SETTINGS.tempUnit),
    clockFormat: asClockFormat(
      storageGet(SETTINGS_KEYS.clockFormat),
      DEFAULT_SETTINGS.clockFormat,
    ),
    idleSeconds: clampIdle(
      Number(storageGet(SETTINGS_KEYS.idleSeconds)) || DEFAULT_SETTINGS.idleSeconds,
    ),
    nightMode: asNightMode(storageGet(SETTINGS_KEYS.nightMode), DEFAULT_SETTINGS.nightMode),
    burnInProtection: asBoolean(
      storageGet(SETTINGS_KEYS.burnInProtection),
      DEFAULT_SETTINGS.burnInProtection,
    ),
    lang: asLang(storageGet(SETTINGS_KEYS.lang), DEFAULT_SETTINGS.lang),
    newsFeedUrl: storageGet(SETTINGS_KEYS.newsFeedUrl) ?? DEFAULT_SETTINGS.newsFeedUrl,
    calendarFeedUrl:
      storageGet(SETTINGS_KEYS.calendarFeedUrl) ?? DEFAULT_SETTINGS.calendarFeedUrl,
    uiStyle: asHomeUiStyle(storageGet(SETTINGS_KEYS.uiStyle), DEFAULT_SETTINGS.uiStyle),
  };
}

function writeLegacySettings(settings: HomeSettings): void {
  storageSet(SETTINGS_KEYS.city, settings.city);
  storageSet(SETTINGS_KEYS.tempUnit, settings.tempUnit);
  storageSet(SETTINGS_KEYS.clockFormat, settings.clockFormat);
  storageSet(SETTINGS_KEYS.idleSeconds, String(settings.idleSeconds));
  storageSet(SETTINGS_KEYS.nightMode, settings.nightMode);
  storageSet(SETTINGS_KEYS.burnInProtection, String(settings.burnInProtection));
  storageSet(SETTINGS_KEYS.lang, settings.lang);
  storageSet(SETTINGS_KEYS.newsFeedUrl, settings.newsFeedUrl);
  storageSet(SETTINGS_KEYS.calendarFeedUrl, settings.calendarFeedUrl);
  storageSet(SETTINGS_KEYS.uiStyle, settings.uiStyle);
}

function readJsonArray<T>(key: string, guard: (value: unknown) => value is T): T[] {
  try {
    const raw = storageGet(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

function isCalendarEvent(value: unknown): value is CalendarEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  const recurring = event.recurring;
  return (
    typeof event.id === "string" &&
    typeof event.title === "string" &&
    typeof event.time === "string" &&
    typeof event.date === "string" &&
    (recurring === undefined || recurring === "daily" || recurring === "weekly")
  );
}

function readLegacyEvents(): CalendarEvent[] {
  return readJsonArray(EVENTS_KEY, isCalendarEvent);
}

function writeLegacyEvents(events: CalendarEvent[]): void {
  storageSet(EVENTS_KEY, JSON.stringify(events));
  window.dispatchEvent(new Event("octos-events-change"));
}

function readLegacyPhotos(): string[] {
  return readJsonArray(PHOTOS_KEY, (value): value is string =>
    typeof value === "string" && value.trim() !== "",
  );
}

function writeLegacyPhotos(photos: string[]): void {
  storageSet(PHOTOS_KEY, JSON.stringify(photos));
}

function isTileLayout(value: unknown): value is TileLayout {
  if (!value || typeof value !== "object") return false;
  const layout = value as Record<string, unknown>;
  return ["col", "row", "w", "h"].every(
    (key) => typeof layout[key] === "number" && Number.isFinite(layout[key]),
  );
}

function readLegacyMetroLayout(): Record<string, TileLayout> {
  try {
    const raw = storageGet(METRO_LAYOUT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, TileLayout] =>
        typeof entry[0] === "string" && isTileLayout(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function writeLegacyMetroLayout(layouts: Record<string, TileLayout>): void {
  storageSet(METRO_LAYOUT_KEY, JSON.stringify(layouts));
}

function readLegacyHomeData(): HomeData {
  return {
    settings: readLegacySettings(),
    widgets: readWidgets(),
    events: readLegacyEvents(),
    photos: readLegacyPhotos(),
    metroLayout: readLegacyMetroLayout(),
  };
}

function writeLegacyHomeData(data: HomeData): void {
  writeLegacySettings(data.settings);
  writeWidgets(data.widgets);
  writeLegacyEvents(data.events);
  writeLegacyPhotos(data.photos);
  writeLegacyMetroLayout(data.metroLayout);
}

function normalizeWidgets(value: unknown, fallback: WidgetConfig[]): WidgetConfig[] {
  if (!Array.isArray(value)) return fallback;
  const incoming = value
    .filter((item): item is WidgetConfig => {
      if (!item || typeof item !== "object") return false;
      const widget = item as Record<string, unknown>;
      return (
        typeof widget.type === "string" &&
        typeof widget.enabled === "boolean" &&
        typeof widget.order === "number" &&
        Number.isFinite(widget.order)
      );
    });
  if (incoming.length === 0) return fallback;
  const known = new Set(DEFAULT_WIDGETS.map((widget) => widget.type));
  const cleaned = incoming.filter((widget) => known.has(widget.type));
  const existing = new Set(cleaned.map((widget) => widget.type));
  let nextOrder = Math.max(0, ...cleaned.map((widget) => widget.order)) + 1;
  for (const widget of DEFAULT_WIDGETS) {
    if (!existing.has(widget.type)) {
      cleaned.push({ ...widget, order: nextOrder++ });
    }
  }
  return cleaned;
}

function normalizeEvents(value: unknown, fallback: CalendarEvent[]): CalendarEvent[] {
  return Array.isArray(value) ? value.filter(isCalendarEvent) : fallback;
}

function normalizePhotos(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : fallback;
}

function normalizeMetroLayout(
  value: unknown,
  fallback: Record<string, TileLayout>,
): Record<string, TileLayout> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, TileLayout] =>
      typeof entry[0] === "string" && isTileLayout(entry[1]),
    ),
  );
}

function mergeProfileHome(
  home: HomeProfileConfig | null | undefined,
  legacy: HomeData,
): HomeData {
  const settings = home?.settings ?? {};
  return {
    settings: {
      city: typeof settings.city === "string" ? settings.city : legacy.settings.city,
      tempUnit: asTempUnit(settings.temp_unit, legacy.settings.tempUnit),
      clockFormat: asClockFormat(settings.clock_format, legacy.settings.clockFormat),
      idleSeconds:
        typeof settings.idle_seconds === "number"
          ? clampIdle(settings.idle_seconds)
          : legacy.settings.idleSeconds,
      nightMode: asNightMode(settings.night_mode, legacy.settings.nightMode),
      burnInProtection: asBoolean(
        settings.burn_in_protection,
        legacy.settings.burnInProtection,
      ),
      lang: asLang(settings.lang, legacy.settings.lang),
      newsFeedUrl:
        typeof settings.news_feed_url === "string" && settings.news_feed_url.trim()
          ? settings.news_feed_url
          : legacy.settings.newsFeedUrl,
      calendarFeedUrl:
        typeof settings.calendar_feed_url === "string"
          ? settings.calendar_feed_url
          : legacy.settings.calendarFeedUrl,
      uiStyle: asHomeUiStyle(settings.ui_style, legacy.settings.uiStyle),
    },
    widgets: normalizeWidgets(home?.widgets, legacy.widgets),
    events: normalizeEvents(home?.events, legacy.events),
    photos: normalizePhotos(home?.photos, legacy.photos),
    metroLayout: normalizeMetroLayout(home?.metro_layout, legacy.metroLayout),
  };
}

function homeHasAnyData(home: HomeProfileConfig | null | undefined): boolean {
  return Boolean(
    home &&
      (home.settings ||
        (home.events?.length ?? 0) > 0 ||
        (home.photos?.length ?? 0) > 0 ||
        (home.widgets?.length ?? 0) > 0 ||
        Object.keys(home.metro_layout ?? {}).length > 0),
  );
}

function serializeHome(data: HomeData): HomeProfileConfig {
  return {
    settings: {
      city: data.settings.city,
      temp_unit: data.settings.tempUnit,
      clock_format: data.settings.clockFormat,
      idle_seconds: data.settings.idleSeconds,
      night_mode: data.settings.nightMode,
      burn_in_protection: data.settings.burnInProtection,
      lang: data.settings.lang,
      news_feed_url: data.settings.newsFeedUrl,
      calendar_feed_url: data.settings.calendarFeedUrl,
      ui_style: data.settings.uiStyle,
    },
    events: data.events,
    photos: data.photos,
    widgets: data.widgets,
    metro_layout: data.metroLayout,
  };
}

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `home-${Date.now().toString(36)}`;
}

const Ctx = createContext<HomeSettingsContextValue | null>(null);

export function HomeSettingsProvider({ children }: { children: ReactNode }) {
  const [homeData, setHomeData] = useState<HomeData>(readLegacyHomeData);
  const [profileBacked, setProfileBacked] = useState(false);
  const profileRef = useRef<Profile | null>(null);
  const saveSeqRef = useRef(0);

  const persistHomeData = useCallback((next: HomeData) => {
    writeLegacyHomeData(next);
    const profile = profileRef.current;
    if (!profile) return;

    const seq = ++saveSeqRef.current;
    updateMyProfileConfig(profile, { home: serializeHome(next) })
      .then((updated) => {
        if (seq >= saveSeqRef.current) {
          profileRef.current = updated;
          setProfileBacked(true);
        }
      })
      .catch((err) => {
        console.warn("[home] failed to persist profile-backed home config", err);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    getMyProfile()
      .then((profile) => {
        if (cancelled || !profile) return;
        profileRef.current = profile;
        setProfileBacked(true);

        const legacy = readLegacyHomeData();
        const next = mergeProfileHome(profile.config.home, legacy);
        setHomeData(next);
        writeLegacyHomeData(next);

        if (!homeHasAnyData(profile.config.home)) {
          persistHomeData(next);
        }
      })
      .catch((err) => {
        console.warn("[home] failed to load profile-backed home config", err);
      });
    return () => {
      cancelled = true;
    };
  }, [persistHomeData]);

  const commit = useCallback((producer: (prev: HomeData) => HomeData) => {
    setHomeData((prev) => {
      const next = producer(prev);
      persistHomeData(next);
      return next;
    });
  }, [persistHomeData]);

  const update = useCallback((patch: Partial<HomeSettings>) => {
    commit((prev) => {
      const settings = { ...prev.settings, ...patch };
      if (patch.idleSeconds !== undefined) {
        settings.idleSeconds = clampIdle(patch.idleSeconds);
      }
      return { ...prev, settings };
    });
  }, [commit]);

  const setWidgets = useCallback((widgets: WidgetConfig[]) => {
    commit((prev) => ({ ...prev, widgets: normalizeWidgets(widgets, prev.widgets) }));
  }, [commit]);

  const toggleWidget = useCallback((type: WidgetType) => {
    commit((prev) => ({
      ...prev,
      widgets: prev.widgets.map((widget) =>
        widget.type === type ? { ...widget, enabled: !widget.enabled } : widget,
      ),
    }));
  }, [commit]);

  const moveWidget = useCallback((type: WidgetType, direction: "up" | "down") => {
    commit((prev) => {
      const sorted = [...prev.widgets].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex((widget) => widget.type === type);
      if (idx < 0) return prev;
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= sorted.length) return prev;
      const widgets = sorted.map((widget, i) => {
        if (i === idx) return { ...widget, order: sorted[swapIdx].order };
        if (i === swapIdx) return { ...widget, order: sorted[idx].order };
        return widget;
      });
      return { ...prev, widgets };
    });
  }, [commit]);

  const addEvent = useCallback((event: Omit<CalendarEvent, "id">) => {
    commit((prev) => ({
      ...prev,
      events: [...prev.events, { ...event, id: makeId() }],
    }));
  }, [commit]);

  const removeEvent = useCallback((id: string) => {
    commit((prev) => ({
      ...prev,
      events: prev.events.filter((event) => event.id !== id),
    }));
  }, [commit]);

  const addPhoto = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    commit((prev) =>
      prev.photos.includes(trimmed)
        ? prev
        : { ...prev, photos: [...prev.photos, trimmed] },
    );
  }, [commit]);

  const removePhoto = useCallback((url: string) => {
    commit((prev) => ({
      ...prev,
      photos: prev.photos.filter((photo) => photo !== url),
    }));
  }, [commit]);

  const setMetroLayout = useCallback((layouts: Record<string, TileLayout>) => {
    commit((prev) => ({ ...prev, metroLayout: layouts }));
  }, [commit]);

  const strings = useMemo(
    () => HOME_I18N[homeData.settings.lang] ?? HOME_I18N.en,
    [homeData.settings.lang],
  );

  const value = useMemo<HomeSettingsContextValue>(
    () => ({
      ...homeData.settings,
      strings,
      update,
      widgets: homeData.widgets,
      setWidgets,
      toggleWidget,
      moveWidget,
      events: homeData.events,
      addEvent,
      removeEvent,
      photos: homeData.photos,
      addPhoto,
      removePhoto,
      metroLayout: homeData.metroLayout,
      setMetroLayout,
      profileBacked,
    }),
    [
      homeData,
      strings,
      update,
      setWidgets,
      toggleWidget,
      moveWidget,
      addEvent,
      removeEvent,
      addPhoto,
      removePhoto,
      setMetroLayout,
      profileBacked,
    ],
  );

  return <Ctx value={value}>{children}</Ctx>;
}

export function useHomeSettings(): HomeSettingsContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useHomeSettings must be used inside HomeSettingsProvider");
  }
  return ctx;
}
