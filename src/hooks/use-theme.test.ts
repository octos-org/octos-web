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

import { initTheme, resolveInitialTheme, resolveInitialUiStyle } from "./use-theme";

function stubMatchMedia(scheme: "light" | "dark" | "none") {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: scheme !== "none" && query.includes(scheme),
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
    document.documentElement.removeAttribute("data-ui-style");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should apply the stored light theme on a direct load with no React component", () => {
    localStorage.setItem("octos-theme", "light");
    stubMatchMedia("none");

    initTheme();

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("should apply the stored dark theme", () => {
    localStorage.setItem("octos-theme", "dark");
    stubMatchMedia("light");

    initTheme();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("should respect an explicit system dark preference when nothing is stored", () => {
    stubMatchMedia("dark");

    expect(resolveInitialTheme()).toBe("dark");

    initTheme();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("should default to the light Ivory flagship when the system expresses no dark preference", () => {
    stubMatchMedia("none");

    expect(resolveInitialTheme()).toBe("light");

    initTheme();

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("should apply the stored legacy blue UI style before React mounts", () => {
    localStorage.setItem("octos-ui-style", "legacy-blue");
    stubMatchMedia("none");

    initTheme();

    expect(document.documentElement.getAttribute("data-ui-style")).toBe("legacy-blue");
  });

  it("should preserve warm palette variants before React mounts", () => {
    localStorage.setItem("octos-ui-style", "warm-sage");
    stubMatchMedia("none");

    expect(resolveInitialUiStyle()).toBe("warm-sage");

    initTheme();

    expect(document.documentElement.getAttribute("data-ui-style")).toBe("warm-sage");
  });

  it("should default fresh installs to Ivory Obsidian", () => {
    stubMatchMedia("none");

    expect(resolveInitialUiStyle()).toBe("ivory-obsidian");

    initTheme();

    expect(document.documentElement.getAttribute("data-ui-style")).toBe("ivory-obsidian");
    // initTheme persisted the choice, so the rebrand marker is now set.
    expect(localStorage.getItem("octos-ui-style-migrated-ivory")).toBe("1");
  });

  it("should rebrand implicit-default warm users to Ivory Obsidian exactly once", () => {
    localStorage.setItem("octos-ui-style", "warm");
    stubMatchMedia("none");

    expect(resolveInitialUiStyle()).toBe("ivory-obsidian");

    initTheme();
    expect(document.documentElement.getAttribute("data-ui-style")).toBe("ivory-obsidian");

    // Choosing warm again after the migration must stick.
    localStorage.setItem("octos-ui-style", "warm");
    expect(resolveInitialUiStyle()).toBe("warm");
  });

  it("should keep the stored Ivory Obsidian style", () => {
    localStorage.setItem("octos-ui-style", "ivory-obsidian");
    stubMatchMedia("none");

    expect(resolveInitialUiStyle()).toBe("ivory-obsidian");
  });
});
