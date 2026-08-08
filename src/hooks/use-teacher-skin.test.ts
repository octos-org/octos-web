import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  resolveInitialTeacherSkin,
  useTeacherSkin,
} from "./use-teacher-skin";

const STORAGE_KEY = "octos-teacher-skin";

beforeEach(() => {
  localStorage.clear();
});

describe("teacher skin preference", () => {
  it("defaults to ocean and ignores unknown stored values", () => {
    expect(resolveInitialTeacherSkin()).toBe("ocean");
    localStorage.setItem(STORAGE_KEY, "invisible");
    expect(resolveInitialTeacherSkin()).toBe("ocean");
  });

  it("persists a skin and notifies other hook instances", () => {
    const first = renderHook(() => useTeacherSkin());
    const second = renderHook(() => useTeacherSkin());

    act(() => first.result.current.setSkin("scholar"));

    expect(localStorage.getItem(STORAGE_KEY)).toBe("scholar");
    expect(first.result.current.skin).toBe("scholar");
    expect(second.result.current.skin).toBe("scholar");
  });

  it("restores a selected 3D model skin", () => {
    localStorage.setItem(STORAGE_KEY, "panda-3d");

    expect(resolveInitialTeacherSkin()).toBe("panda-3d");
  });
});
