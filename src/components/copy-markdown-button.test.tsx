/**
 * Unit tests for `CopyMarkdownButton`.
 *
 * Coverage:
 *   1. Renders a clickable button with the documented `aria-label` /
 *      `data-testid`, plus the `Copy` icon while idle.
 *   2. Click writes the supplied markdown to `navigator.clipboard` and
 *      swaps the icon to a checkmark (`data-state="copied"`) for
 *      1.5s, then reverts to idle.
 *   3. Clipboard rejection falls back to the legacy `execCommand`
 *      path; if THAT also fails the button surfaces the error state
 *      (`data-state="error"`).
 *   4. The aria-label updates with state so screen readers announce
 *      success / failure.
 *
 * Test rig mirrors the rest of the repo — `react-dom/client` + `act`,
 * no `@testing-library/react`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { CopyMarkdownButton } from "./copy-markdown-button";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mount(node: React.ReactElement): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  for (const node of [...document.body.children]) {
    node.remove();
  }
});

describe("CopyMarkdownButton", () => {
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      // Test installed a stub on a clipboard-less navigator; remove it.
      delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  function stubClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: { writeText },
    });
  }

  it("renders an idle copy button with the documented aria-label", () => {
    const { container, unmount } = mount(
      <CopyMarkdownButton content="# Hello" />,
    );
    const btn = container.querySelector(
      "[data-testid='copy-markdown-button']",
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("Copy as markdown");
    expect(btn!.getAttribute("data-state")).toBe("idle");
    // Lucide renders an inline <svg>; just confirm SOME glyph is mounted.
    expect(btn!.querySelector("svg")).not.toBeNull();
    unmount();
  });

  it("writes the markdown to clipboard and shows the copied state for 1.5s", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    const markdown = "# Title\n\nSome **bold** body.";
    const { container, unmount } = mount(
      <CopyMarkdownButton content={markdown} />,
    );

    const btn = container.querySelector(
      "[data-testid='copy-markdown-button']",
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
      // Flush the resolved clipboard promise.
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(markdown);
    expect(btn.getAttribute("data-state")).toBe("copied");
    expect(btn.getAttribute("aria-label")).toBe("Copied");

    // Just before the revert timer fires — still copied.
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(btn.getAttribute("data-state")).toBe("copied");

    // Cross the 1.5s threshold — revert to idle.
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(btn.getAttribute("data-state")).toBe("idle");
    expect(btn.getAttribute("aria-label")).toBe("Copy as markdown");

    unmount();
  });

  it("surfaces an error state when both async and legacy copy fail", async () => {
    stubClipboard(() => Promise.reject(new Error("permission denied")));
    // Force the legacy path to fail too. jsdom doesn't ship
    // `document.execCommand`, so attach a stub first.
    const originalExec = (document as unknown as { execCommand?: unknown })
      .execCommand;
    (document as unknown as { execCommand: () => boolean }).execCommand = () =>
      false;
    const execSpy = vi
      .spyOn(document, "execCommand")
      .mockReturnValue(false);

    const { container, unmount } = mount(
      <CopyMarkdownButton content="hello" />,
    );
    const btn = container.querySelector(
      "[data-testid='copy-markdown-button']",
    ) as HTMLButtonElement;

    await act(async () => {
      btn.click();
      // Drain both the rejected promise + microtask queue.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(btn.getAttribute("data-state")).toBe("error");
    expect(btn.getAttribute("aria-label")).toBe("Copy failed");

    // Error state also reverts after 1.5s.
    act(() => {
      vi.advanceTimersByTime(1501);
    });
    expect(btn.getAttribute("data-state")).toBe("idle");

    execSpy.mockRestore();
    if (originalExec === undefined) {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    } else {
      (document as unknown as { execCommand: unknown }).execCommand = originalExec;
    }
    unmount();
  });

  it("uses the legacy execCommand path when navigator.clipboard is unavailable", async () => {
    // No clipboard on navigator (simulate an insecure-context page).
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const originalExec = (document as unknown as { execCommand?: unknown })
      .execCommand;
    (document as unknown as { execCommand: () => boolean }).execCommand = () =>
      true;
    const execSpy = vi
      .spyOn(document, "execCommand")
      .mockReturnValue(true);

    const { container, unmount } = mount(
      <CopyMarkdownButton content="legacy md" />,
    );
    const btn = container.querySelector(
      "[data-testid='copy-markdown-button']",
    ) as HTMLButtonElement;

    await act(async () => {
      btn.click();
      await Promise.resolve();
    });

    expect(execSpy).toHaveBeenCalledWith("copy");
    expect(btn.getAttribute("data-state")).toBe("copied");

    execSpy.mockRestore();
    if (originalExec === undefined) {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
    } else {
      (document as unknown as { execCommand: unknown }).execCommand = originalExec;
    }
    unmount();
  });
});
