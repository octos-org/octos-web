/**
 * Home Settings Context — centralised settings state for the Home UI.
 *
 * Reads initial values from localStorage (keys prefixed `octos_home_`),
 * exposes typed getters and an `update` function that persists changes
 * back to localStorage.
 *
 * Wrap the Home page root with `<HomeSettingsProvider>` and consume via
 * `useHomeSettings()`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { HOME_I18N, type HomeStrings } from "./constants";
import {
  readWidgets,
  writeWidgets,
  type WidgetConfig,
  type WidgetType,
} from "./widget-registry";

// ── Types ───────────────────────────────────────────────────────

export type TempUnit = "C" | "F";
export type ClockFormat = "12h" | "24h";
export type NightMode = "auto" | "on" | "off";
export type Lang = "en" | "zh";

export interface HomeSettings {
  city: string;
  tempUnit: TempUnit;
  clockFormat: ClockFormat;
  idleSeconds: number;
  nightMode: NightMode;
  lang: Lang;
}

export interface HomeSettingsContextValue extends HomeSettings {
  /** Localised string table for the active language. */
  strings: HomeStrings;
  /** Partially update settings (only changed keys). */
  update: (patch: Partial<HomeSettings>) => void;
  /** Current widget configuration. */
  widgets: WidgetConfig[];
  /** Replace the entire widget config. */
  setWidgets: (widgets: WidgetConfig[]) => void;
  /** Toggle a single widget on/off. */
  toggleWidget: (type: WidgetType) => void;
  /** Move a widget up or down in order. */
  moveWidget: (type: WidgetType, direction: "up" | "down") => void;
}

// ── Storage helpers ─────────────────────────────────────────────

const KEYS = {
  city: "octos_home_city",
  tempUnit: "octos_home_temp_unit",
  clockFormat: "octos_home_clock_format",
  idleSeconds: "octos_home_idle_seconds",
  nightMode: "octos_home_night_mode",
  lang: "octos_home_lang",
} as const;

function readLS(): HomeSettings {
  return {
    city: localStorage.getItem(KEYS.city) ?? "",
    tempUnit: (localStorage.getItem(KEYS.tempUnit) as TempUnit) || "C",
    clockFormat:
      (localStorage.getItem(KEYS.clockFormat) as ClockFormat) || "24h",
    idleSeconds: clampIdle(
      Number(localStorage.getItem(KEYS.idleSeconds)) || 30,
    ),
    nightMode:
      (localStorage.getItem(KEYS.nightMode) as NightMode) || "auto",
    lang: (localStorage.getItem(KEYS.lang) as Lang) || "en",
  };
}

function writeLS(s: HomeSettings) {
  localStorage.setItem(KEYS.city, s.city);
  localStorage.setItem(KEYS.tempUnit, s.tempUnit);
  localStorage.setItem(KEYS.clockFormat, s.clockFormat);
  localStorage.setItem(KEYS.idleSeconds, String(s.idleSeconds));
  localStorage.setItem(KEYS.nightMode, s.nightMode);
  localStorage.setItem(KEYS.lang, s.lang);
}

function clampIdle(n: number): number {
  return Math.max(10, Math.min(300, Math.round(n)));
}

// ── Context ─────────────────────────────────────────────────────

const Ctx = createContext<HomeSettingsContextValue | null>(null);

export function HomeSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<HomeSettings>(readLS);
  const [widgets, setWidgetsRaw] = useState<WidgetConfig[]>(readWidgets);

  const update = useCallback((patch: Partial<HomeSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      if (patch.idleSeconds !== undefined) {
        next.idleSeconds = clampIdle(patch.idleSeconds);
      }
      writeLS(next);
      return next;
    });
  }, []);

  const setWidgets = useCallback((next: WidgetConfig[]) => {
    setWidgetsRaw(next);
    writeWidgets(next);
  }, []);

  const toggleWidget = useCallback((type: WidgetType) => {
    setWidgetsRaw((prev) => {
      const next = prev.map((w) =>
        w.type === type ? { ...w, enabled: !w.enabled } : w,
      );
      writeWidgets(next);
      return next;
    });
  }, []);

  const moveWidget = useCallback((type: WidgetType, direction: "up" | "down") => {
    setWidgetsRaw((prev) => {
      const sorted = [...prev].sort((a, b) => a.order - b.order);
      const idx = sorted.findIndex((w) => w.type === type);
      if (idx < 0) return prev;
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= sorted.length) return prev;
      // Swap orders
      const next = sorted.map((w, i) => {
        if (i === idx) return { ...w, order: sorted[swapIdx].order };
        if (i === swapIdx) return { ...w, order: sorted[idx].order };
        return w;
      });
      writeWidgets(next);
      return next;
    });
  }, []);

  const strings = useMemo(
    () => HOME_I18N[settings.lang] ?? HOME_I18N.en,
    [settings.lang],
  );

  const value = useMemo<HomeSettingsContextValue>(
    () => ({ ...settings, strings, update, widgets, setWidgets, toggleWidget, moveWidget }),
    [settings, strings, update, widgets, setWidgets, toggleWidget, moveWidget],
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
