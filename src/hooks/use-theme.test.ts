/**
 * Theme bootstrap unit tests.
 *
 * Regression: the sites/slides gallery routes render no component that
 * calls `useTheme`, so on a hard refresh the `data-theme` attribute was
 * never applied and the CSS dark default leaked through even when the
 * stored preference was "light". `initTheme()` makes theme application a
 * global boot step that runs before React mounts, independent of any
 * component tree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initTheme, resolveInitialTheme } from "./use-theme";

function stubMatchMedia(lightMatches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("light") ? lightMatches : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

describe("initTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should apply the stored light theme on a direct load with no React component", () => {
    localStorage.setItem("octos-theme", "light");
    stubMatchMedia(false);

    initTheme();

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("should apply the stored dark theme", () => {
    localStorage.setItem("octos-theme", "dark");
    stubMatchMedia(true);

    initTheme();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("should fall back to the system light preference when nothing is stored", () => {
    stubMatchMedia(true);

    expect(resolveInitialTheme()).toBe("light");

    initTheme();

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("should default to dark when nothing is stored and the system is not light", () => {
    stubMatchMedia(false);

    expect(resolveInitialTheme()).toBe("dark");

    initTheme();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
