import { useState, useEffect, useCallback } from "react";

type Theme = "dark" | "light";
export type UiStyle = "warm" | "warm-sage" | "warm-daylight" | "legacy-blue";

const STORAGE_KEY = "octos-theme";
const UI_STYLE_STORAGE_KEY = "octos-ui-style";
const THEME_CHANGE_EVENT = "octos-theme-change";
const UI_STYLE_CHANGE_EVENT = "octos-ui-style-change";

/**
 * Resolve the active theme from the stored preference, falling back to the
 * system `prefers-color-scheme` and finally to dark. Pure: reads storage and
 * media queries but mutates nothing.
 */
export function resolveInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // Respect system preference
  if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}

export function resolveInitialUiStyle(): UiStyle {
  const stored = localStorage.getItem(UI_STYLE_STORAGE_KEY);
  if (
    stored === "warm" ||
    stored === "warm-sage" ||
    stored === "warm-daylight" ||
    stored === "legacy-blue"
  ) {
    return stored;
  }
  if (stored === "classic" || stored === "classic-blue") return "legacy-blue";
  return "warm";
}

/** Reflect a theme onto `<html>` and persist it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEY, theme);
}

export function applyUiStyle(uiStyle: UiStyle): void {
  document.documentElement.setAttribute("data-ui-style", uiStyle);
  localStorage.setItem(UI_STYLE_STORAGE_KEY, uiStyle);
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
      if (
        next === "warm" ||
        next === "warm-sage" ||
        next === "warm-daylight" ||
        next === "legacy-blue"
      ) {
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
