import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryRouter } from "react-router-dom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const soloCreate = vi.fn();
vi.mock("./auth-context", () => ({ useAuth: () => ({ soloCreate }) }));

import { SoloProfileForm } from "./solo-profile-form";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
}

function mount(node: React.ReactElement): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function setInput(container: HTMLElement, testid: string, value: string) {
  const el = container.querySelector(
    `[data-testid="${testid}"]`,
  ) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitBtn(container: HTMLElement): HTMLButtonElement {
  return container.querySelector(
    '[data-testid="solo-submit"]',
  ) as HTMLButtonElement;
}

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  soloCreate.mockReset();
});

describe("SoloProfileForm", () => {
  it("keeps submit disabled until a name is entered, then submits the trimmed name", async () => {
    soloCreate.mockResolvedValue(undefined);
    const onDone = vi.fn();
    const { container } = mount(
      <MemoryRouter>
        <SoloProfileForm onDone={onDone} />
      </MemoryRouter>,
    );

    expect(submitBtn(container).disabled).toBe(true);

    setInput(container, "solo-name", "  Ada Lovelace ");
    expect(submitBtn(container).disabled).toBe(false);

    await act(async () => {
      submitBtn(container).click();
    });

    expect(soloCreate).toHaveBeenCalledWith({ name: "Ada Lovelace" });
    expect(onDone).toHaveBeenCalled();
  });

  it("keeps submit disabled for a whitespace-only name", () => {
    const { container } = mount(
      <MemoryRouter>
        <SoloProfileForm />
      </MemoryRouter>,
    );
    setInput(container, "solo-name", "   ");
    expect(submitBtn(container).disabled).toBe(true);
  });

  it("shows a length hint for an over-long name", () => {
    const { container } = mount(
      <MemoryRouter>
        <SoloProfileForm />
      </MemoryRouter>,
    );
    const el = container.querySelector('[data-testid="solo-name"]')!;
    act(() => {
      // React's onBlur delegates to the "focusout" event type.
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    setInput(container, "solo-name", "x".repeat(129));
    expect(container.textContent).toContain("128 characters");
    expect(submitBtn(container).disabled).toBe(true);
  });

  it("surfaces a server rejection", async () => {
    soloCreate.mockRejectedValue(new Error("username taken"));
    const { container } = mount(
      <MemoryRouter>
        <SoloProfileForm />
      </MemoryRouter>,
    );
    setInput(container, "solo-name", "Ada");
    await act(async () => {
      submitBtn(container).click();
    });
    const err = container.querySelector('[data-testid="solo-error"]');
    expect(err?.textContent).toContain("username taken");
  });

  it("gives the name input an accessible name (placeholder is not a label)", () => {
    const { container } = mount(
      <MemoryRouter>
        <SoloProfileForm />
      </MemoryRouter>,
    );
    const el = container.querySelector(
      '[data-testid="solo-name"]',
    ) as HTMLInputElement;
    expect(el.getAttribute("aria-label")).toBe("What should we call you?");
  });
});
