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
  it("keeps submit disabled until name/username/email are valid, then submits trimmed values", async () => {
    soloCreate.mockResolvedValue(undefined);
    const onDone = vi.fn();
    const { container } = mount(
      <MemoryRouter>
        <SoloProfileForm onDone={onDone} />
      </MemoryRouter>,
    );

    expect(submitBtn(container).disabled).toBe(true);

    setInput(container, "solo-name", "  Ada Lovelace ");
    setInput(container, "solo-username", " ada ");
    expect(submitBtn(container).disabled).toBe(true); // email still missing

    setInput(container, "solo-email", " ada@example.com ");
    expect(submitBtn(container).disabled).toBe(false);

    await act(async () => {
      submitBtn(container).click();
    });

    expect(soloCreate).toHaveBeenCalledWith({
      name: "Ada Lovelace",
      username: "ada",
      email: "ada@example.com",
    });
    expect(onDone).toHaveBeenCalled();
  });

  it("keeps submit disabled for an invalid username", () => {
    const { container } = mount(
      <MemoryRouter>
        <SoloProfileForm />
      </MemoryRouter>,
    );
    setInput(container, "solo-name", "Ada");
    setInput(container, "solo-username", "has space");
    setInput(container, "solo-email", "ada@example.com");
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
    setInput(container, "solo-username", "ada");
    setInput(container, "solo-email", "ada@example.com");
    await act(async () => {
      submitBtn(container).click();
    });
    const err = container.querySelector('[data-testid="solo-error"]');
    expect(err?.textContent).toContain("username taken");
  });
});
