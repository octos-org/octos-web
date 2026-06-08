import { useState, useEffect, useCallback } from "react";

type Theme = "dark" | "light";

const STORAGE_KEY = "octos-theme";

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

/** Reflect a theme onto `<html>` and persist it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEY, theme);
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
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme };
}
