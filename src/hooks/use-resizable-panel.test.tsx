import { act, cleanup, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useResizablePanel } from "./use-resizable-panel";

afterEach(() => {
  cleanup();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  localStorage.clear();
});

function pointerEvent(overrides: Partial<React.PointerEvent> = {}): React.PointerEvent {
  return {
    button: 0,
    clientX: 400,
    isPrimary: true,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as React.PointerEvent;
}

describe("useResizablePanel", () => {
  it.each([
    ["right button", { button: 2 }],
    ["non-primary pointer", { isPrimary: false }],
  ])("ignores a %s resize start", (_label, overrides) => {
    const { result } = renderHook(() => useResizablePanel({ storageKey: "resize-test" }));
    const event = pointerEvent(overrides);

    act(() => result.current.onPointerDown(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("cleans up an active pointer drag when the window loses focus", () => {
    const { result } = renderHook(() => useResizablePanel({ storageKey: "resize-test" }));

    act(() => result.current.onPointerDown(pointerEvent()));
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    act(() => window.dispatchEvent(new Event("blur")));

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("cleans up an active pointer drag when the hook unmounts", () => {
    const { result, unmount } = renderHook(() => useResizablePanel({ storageKey: "resize-test" }));

    act(() => result.current.onPointerDown(pointerEvent()));
    expect(document.body.style.userSelect).toBe("none");

    unmount();

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});
