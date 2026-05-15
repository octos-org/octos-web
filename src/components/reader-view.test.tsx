/**
 * Tests for the fullscreen reader-view feature.
 *
 * Covers:
 *   1. Open via trigger -> dialog renders with markdown content +
 *      proper a11y attributes (`role="dialog"`, `aria-modal="true"`,
 *      `aria-labelledby`).
 *   2. ESC key closes the dialog.
 *   3. Click on the backdrop closes the dialog.
 *   4. The close button receives focus on open.
 *   5. The X close button closes the dialog.
 *
 * Test rig matches the rest of the repo — `react-dom/client` + `act`,
 * no `@testing-library/react`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { ReaderViewTrigger } from "./reader-view-trigger";

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

/** Yield to the microtask queue so portal renders + focus moves
 *  schedule before we assert. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Locate the portaled dialog in `document.body` (not the mount
 *  container — the reader portals out). */
function queryDialog(): HTMLElement | null {
  return document.body.querySelector("[data-testid='reader-view']");
}

function queryCloseButton(): HTMLButtonElement | null {
  return document.body.querySelector(
    "[data-testid='reader-view-close']",
  ) as HTMLButtonElement | null;
}

function queryBackdrop(): HTMLElement | null {
  return document.body.querySelector("[data-testid='reader-view-backdrop']");
}

function queryArticle(): HTMLElement | null {
  return document.body.querySelector("[data-testid='reader-view-article']");
}

afterEach(() => {
  // Clear body — the reader portals to document.body so the test
  // container alone isn't enough.
  for (const node of [...document.body.children]) {
    node.remove();
  }
  document.body.style.overflow = "";
});

describe("ReaderView (via ReaderViewTrigger)", () => {
  const markdown =
    "# Research report\n\nA fully-fledged **markdown** report.\n\n- bullet one\n- bullet two\n";

  beforeEach(() => {
    // Reset any leftover scroll lock from a previous test.
    document.body.style.overflow = "";
  });

  it("renders an idle trigger with the documented aria-label and no dialog mounted", () => {
    const { container, unmount } = mount(
      <ReaderViewTrigger content={markdown} />,
    );
    const trigger = container.querySelector(
      "[data-testid='reader-view-trigger']",
    ) as HTMLButtonElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute("aria-label")).toBe("Open reader view");
    // Dialog not yet mounted.
    expect(queryDialog()).toBeNull();
    unmount();
  });

  it("opens the dialog with the markdown content and proper a11y wiring", async () => {
    const { container, unmount } = mount(
      <ReaderViewTrigger content={markdown} />,
    );
    const trigger = container.querySelector(
      "[data-testid='reader-view-trigger']",
    ) as HTMLButtonElement;

    await act(async () => {
      trigger.click();
    });
    await flushMicrotasks();

    const dialog = queryDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("role")).toBe("dialog");
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(dialog!.getAttribute("aria-labelledby")).toBeTruthy();
    // The label element pointed to by aria-labelledby is in the DOM
    // and has some text content.
    const labelId = dialog!.getAttribute("aria-labelledby")!;
    const labelEl = document.getElementById(labelId);
    expect(labelEl).not.toBeNull();
    expect(labelEl!.textContent?.trim()).not.toBe("");

    // The markdown rendered into the article. We look for the H1
    // heading text since it's a stable substring of the rendered HTML.
    const article = queryArticle();
    expect(article).not.toBeNull();
    expect(article!.textContent ?? "").toContain("Research report");
    expect(article!.textContent ?? "").toContain("bullet one");

    unmount();
  });

  it("moves focus to the close button on open", async () => {
    const { container, unmount } = mount(
      <ReaderViewTrigger content={markdown} />,
    );
    const trigger = container.querySelector(
      "[data-testid='reader-view-trigger']",
    ) as HTMLButtonElement;

    await act(async () => {
      trigger.click();
    });
    await flushMicrotasks();

    const closeBtn = queryCloseButton();
    expect(closeBtn).not.toBeNull();
    expect(document.activeElement).toBe(closeBtn);

    unmount();
  });

  it("closes the dialog when ESC is pressed", async () => {
    const { container, unmount } = mount(
      <ReaderViewTrigger content={markdown} />,
    );
    const trigger = container.querySelector(
      "[data-testid='reader-view-trigger']",
    ) as HTMLButtonElement;

    await act(async () => {
      trigger.click();
    });
    await flushMicrotasks();

    expect(queryDialog()).not.toBeNull();

    const dialog = queryDialog()!;
    await act(async () => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // Wait out the 180ms close transition.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });

    expect(queryDialog()).toBeNull();

    unmount();
  });

  it("closes the dialog when the close button is clicked", async () => {
    const { container, unmount } = mount(
      <ReaderViewTrigger content={markdown} />,
    );
    const trigger = container.querySelector(
      "[data-testid='reader-view-trigger']",
    ) as HTMLButtonElement;

    await act(async () => {
      trigger.click();
    });
    await flushMicrotasks();

    const closeBtn = queryCloseButton();
    expect(closeBtn).not.toBeNull();
    await act(async () => {
      closeBtn!.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });

    expect(queryDialog()).toBeNull();
    unmount();
  });

  it("closes the dialog when the backdrop is clicked", async () => {
    const { container, unmount } = mount(
      <ReaderViewTrigger content={markdown} />,
    );
    const trigger = container.querySelector(
      "[data-testid='reader-view-trigger']",
    ) as HTMLButtonElement;

    await act(async () => {
      trigger.click();
    });
    await flushMicrotasks();

    const backdrop = queryBackdrop();
    expect(backdrop).not.toBeNull();
    // Synthesize a mousedown event whose `target === currentTarget`
    // (i.e. on the backdrop itself, not a bubble from inside the
    // dialog). React's synthetic event uses the actual DOM target,
    // so dispatching directly on `backdrop` is sufficient.
    await act(async () => {
      backdrop!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });

    expect(queryDialog()).toBeNull();
    unmount();
  });

  it("locks body scroll while open and restores it on close", async () => {
    document.body.style.overflow = "auto";
    const { container, unmount } = mount(
      <ReaderViewTrigger content={markdown} />,
    );
    const trigger = container.querySelector(
      "[data-testid='reader-view-trigger']",
    ) as HTMLButtonElement;

    await act(async () => {
      trigger.click();
    });
    await flushMicrotasks();
    expect(document.body.style.overflow).toBe("hidden");

    const closeBtn = queryCloseButton()!;
    await act(async () => {
      closeBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    expect(document.body.style.overflow).toBe("auto");

    unmount();
  });
});
