/**
 * Widget Registry — defines available widget types and default config.
 *
 * Widget configs are persisted in localStorage (`octos_home_widgets`).
 * The settings context exposes helpers to toggle / reorder widgets.
 */

export type WidgetType =
  | "clock"
  | "weather"
  | "quick-actions"
  | "voice-orb"
  | "greeting"
  | "news"
  | "calendar";

export interface WidgetConfig {
  type: WidgetType;
  enabled: boolean;
  order: number;
}

export const DEFAULT_WIDGETS: WidgetConfig[] = [
  { type: "greeting", enabled: true, order: 0 },
  { type: "clock", enabled: true, order: 1 },
  { type: "voice-orb", enabled: true, order: 2 },
  { type: "weather", enabled: true, order: 3 },
  { type: "quick-actions", enabled: true, order: 4 },
  { type: "news", enabled: true, order: 5 },
  { type: "calendar", enabled: true, order: 6 },
];

const LS_KEY = "octos_home_widgets";

/** Read widget config from localStorage, falling back to defaults.
 *  If persisted config is missing newly-added widget types, merge them in. */
export function readWidgets(): WidgetConfig[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_WIDGETS;
    const parsed = JSON.parse(raw) as WidgetConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_WIDGETS;
    // Merge any missing default widgets (added in newer versions).
    const types = new Set(parsed.map((w) => w.type));
    const maxOrder = Math.max(...parsed.map((w) => w.order), 0);
    let nextOrder = maxOrder + 1;
    for (const dw of DEFAULT_WIDGETS) {
      if (!types.has(dw.type)) {
        parsed.push({ ...dw, order: nextOrder++ });
      }
    }
    return parsed;
  } catch {
    return DEFAULT_WIDGETS;
  }
}

/** Persist widget config to localStorage. */
export function writeWidgets(widgets: WidgetConfig[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(widgets));
}
