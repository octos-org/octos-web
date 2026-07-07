import { useState, useEffect, useCallback } from "react";

type Theme = "dark" | "light";

const UI_STYLES = [
  "ivory-obsidian",
  "warm",
  "warm-sage",
  "warm-daylight",
  "legacy-blue",
] as const;
export type UiStyle = (typeof UI_STYLES)[number];

function isUiStyle(value: unknown): value is UiStyle {
  return (
    typeof value === "string" && (UI_STYLES as readonly string[]).includes(value)
  );
}

const STORAGE_KEY = "octos-theme";
const UI_STYLE_STORAGE_KEY = "octos-ui-style";
// Present once a ui-style has been persisted by a build that knows about
// Ivory Obsidian; gates the one-time "warm" → "ivory-obsidian" rebrand below.
const UI_STYLE_MIGRATION_KEY = "octos-ui-style-migrated-ivory";
const THEME_CHANGE_EVENT = "octos-theme-change";
const UI_STYLE_CHANGE_EVENT = "octos-ui-style-change";

/**
 * Resolve the active theme from the stored preference, then an explicit
 * system dark preference, finally the light "Ivory" flagship. Pure: reads
 * storage and media queries but mutates nothing.
 */
export function resolveInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

export function resolveInitialUiStyle(): UiStyle {
  const stored = localStorage.getItem(UI_STYLE_STORAGE_KEY);
  // One-time rebrand: "warm" was the implicit default before Ivory Obsidian
  // shipped, so carry those users to the new flagship. Choosing any style in
  // Settings afterwards re-persists it alongside the migration marker and
  // sticks — including choosing "warm" back.
  if (stored === "warm" && !localStorage.getItem(UI_STYLE_MIGRATION_KEY)) {
    return "ivory-obsidian";
  }
  if (isUiStyle(stored)) return stored;
  if (stored === "classic" || stored === "classic-blue") return "legacy-blue";
  return "ivory-obsidian";
}

/** Reflect a theme onto `<html>` and persist it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEY, theme);
}

export function applyUiStyle(uiStyle: UiStyle): void {
  document.documentElement.setAttribute("data-ui-style", uiStyle);
  localStorage.setItem(UI_STYLE_STORAGE_KEY, uiStyle);
  localStorage.setItem(UI_STYLE_MIGRATION_KEY, "1");
}

/**
 * Apply the resolved theme once at boot, before React mounts. This must run
 * globally rather than inside `useTheme`, because routes like the sites and
 * slides galleries render no component that calls the hook — without this, a
 * hard refresh on those pages leaves `data-theme` unset and the CSS dark
 * default leaks through even when the stored preference is "light".
 */
export function initTheme(): void {
  applyTheme(resolveInitialTheme());
  applyUiStyle(resolveInitialUiStyle());
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);
  const [uiStyle, setUiStyleState] = useState<UiStyle>(resolveInitialUiStyle);

  useEffect(() => {
    const onThemeChange = (event: Event) => {
      const next = event instanceof CustomEvent ? event.detail : null;
      if (next === "dark" || next === "light") {
        setThemeState(next);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setThemeState(resolveInitialTheme());
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    const onUiStyleChange = (event: Event) => {
      const next = event instanceof CustomEvent ? event.detail : null;
      if (isUiStyle(next)) {
        setUiStyleState(next);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === UI_STYLE_STORAGE_KEY) {
        setUiStyleState(resolveInitialUiStyle());
      }
    };
    window.addEventListener(UI_STYLE_CHANGE_EVENT, onUiStyleChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(UI_STYLE_CHANGE_EVENT, onUiStyleChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    applyUiStyle(uiStyle);
  }, [uiStyle]);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setThemeState(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
  }, []);

  const setUiStyle = useCallback((next: UiStyle) => {
    applyUiStyle(next);
    setUiStyleState(next);
    window.dispatchEvent(new CustomEvent(UI_STYLE_CHANGE_EVENT, { detail: next }));
  }, []);

  return { theme, setTheme, toggleTheme, uiStyle, setUiStyle };
}
