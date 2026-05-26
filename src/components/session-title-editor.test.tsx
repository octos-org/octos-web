import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { SessionTitleEditor } from "./session-title-editor";

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

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function commitInput(input: HTMLInputElement) {
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
});

describe("SessionTitleEditor", () => {
  it("commits a trimmed title on blur", () => {
    const onSave = vi.fn();
    const harness = mount(
      <SessionTitleEditor value="Original title" onSave={onSave} />,
    );
    try {
      const button = harness.container.querySelector(
        "[data-testid='session-title-editor']",
      ) as HTMLButtonElement;
      act(() => button.click());

      const input = harness.container.querySelector(
        "[data-testid='session-title-editor-input']",
      ) as HTMLInputElement;
      expect(input.value).toBe("Original title");

      act(() => {
        setInputValue(input, "  Renamed session  ");
        commitInput(input);
      });

      expect(onSave).toHaveBeenCalledWith("Renamed session");
    } finally {
      harness.unmount();
    }
  });

  it("ignores empty and unchanged titles", () => {
    const onSave = vi.fn();
    const harness = mount(
      <SessionTitleEditor value="Original title" onSave={onSave} />,
    );
    try {
      const button = harness.container.querySelector(
        "[data-testid='session-title-editor']",
      ) as HTMLButtonElement;
      act(() => button.click());
      let input = harness.container.querySelector(
        "[data-testid='session-title-editor-input']",
      ) as HTMLInputElement;
      act(() => {
        setInputValue(input, "   ");
        commitInput(input);
      });

      const nextButton = harness.container.querySelector(
        "[data-testid='session-title-editor']",
      ) as HTMLButtonElement;
      act(() => nextButton.click());
      input = harness.container.querySelector(
        "[data-testid='session-title-editor-input']",
      ) as HTMLInputElement;
      act(() => {
        setInputValue(input, "Original title");
        commitInput(input);
      });

      expect(onSave).not.toHaveBeenCalled();
    } finally {
      harness.unmount();
    }
  });

  it("cancels editing on Escape", () => {
    const onSave = vi.fn();
    const harness = mount(
      <SessionTitleEditor value="Original title" onSave={onSave} />,
    );
    try {
      const button = harness.container.querySelector(
        "[data-testid='session-title-editor']",
      ) as HTMLButtonElement;
      act(() => button.click());
      const input = harness.container.querySelector(
        "[data-testid='session-title-editor-input']",
      ) as HTMLInputElement;

      act(() => {
        setInputValue(input, "Should not save");
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });

      expect(onSave).not.toHaveBeenCalled();
      expect(
        harness.container.querySelector("[data-testid='session-title-editor']"),
      ).not.toBeNull();
    } finally {
      harness.unmount();
    }
  });
});
