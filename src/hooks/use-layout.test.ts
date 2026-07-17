import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { resolveInitialLayout, useLayout } from "./use-layout";

const STORAGE_KEY = "octos-layout";

beforeEach(() => {
  localStorage.clear();
});

describe("resolveInitialLayout", () => {
  it("defaults to classic when nothing is stored", () => {
    expect(resolveInitialLayout()).toBe("classic");
  });

  it("resolves a stored workspace preference", () => {
    localStorage.setItem(STORAGE_KEY, "workspace");
    expect(resolveInitialLayout()).toBe("workspace");
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem(STORAGE_KEY, "holographic");
    expect(resolveInitialLayout()).toBe("classic");
  });
});

describe("useLayout", () => {
  it("persists setLayout and notifies other hook instances", () => {
    const first = renderHook(() => useLayout());
    const second = renderHook(() => useLayout());

    act(() => {
      first.result.current.setLayout("workspace");
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBe("workspace");
    expect(first.result.current.layout).toBe("workspace");
    expect(second.result.current.layout).toBe("workspace");
  });

  it("switches back to classic", () => {
    localStorage.setItem(STORAGE_KEY, "workspace");
    const { result } = renderHook(() => useLayout());
    expect(result.current.layout).toBe("workspace");

    act(() => {
      result.current.setLayout("classic");
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBe("classic");
    expect(result.current.layout).toBe("classic");
  });
});
