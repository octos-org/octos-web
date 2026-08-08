import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OctosSkinArt } from "./octos-skin-art";

class FakeModelViewerElement extends HTMLElement {
  loaded = false;
  availableAnimations = ["MonsterArmature|Idle", "MonsterArmature|Jump"];
  animationCrossfadeDuration = 0;
  animationName = "";
  currentTime = 0;
  play = vi.fn();
  pause = vi.fn();
}

if (!customElements.get("model-viewer")) {
  customElements.define("model-viewer", FakeModelViewerElement);
}

const originalMatchMedia = window.matchMedia;
const originalWebGl = Object.getOwnPropertyDescriptor(
  window,
  "WebGLRenderingContext",
);

function enableWebGl() {
  Object.defineProperty(window, "WebGLRenderingContext", {
    configurable: true,
    value: class WebGLRenderingContext {},
  });
}

function installReducedMotionQuery(initialMatches = false) {
  let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
  const mediaQuery = {
    matches: initialMatches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        changeListener = listener;
      },
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (changeListener === listener) changeListener = undefined;
      },
    ),
  };

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => mediaQuery as unknown as MediaQueryList),
  });

  return {
    setMatches(matches: boolean) {
      mediaQuery.matches = matches;
      changeListener?.({ matches } as MediaQueryListEvent);
    },
  };
}

describe("OctosSkinArt", () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    if (originalWebGl) {
      Object.defineProperty(window, "WebGLRenderingContext", originalWebGl);
    } else {
      Reflect.deleteProperty(window, "WebGLRenderingContext");
    }
  });

  it("keeps a matching SVG fallback when WebGL is unavailable", () => {
    Reflect.deleteProperty(window, "WebGLRenderingContext");
    const { container } = render(
      <OctosSkinArt
        skin="panda-3d"
        className="preview"
        activity="thinking"
      />,
    );

    expect(
      container.querySelector(".octos-model-art")?.getAttribute("data-failed"),
    ).toBe("true");
    expect(
      container.querySelector(".octos-avatar-art")?.getAttribute("data-skin"),
    ).toBe("scholar");
    expect(container.querySelector("model-viewer")).toBeNull();
  });

  it("does not replay a reaction that happened before the model loaded", () => {
    enableWebGl();
    installReducedMotionQuery();
    const { container, rerender } = render(
      <OctosSkinArt skin="panda-3d" reactionKey={0} />,
    );
    const viewer = container.querySelector(
      "model-viewer",
    ) as FakeModelViewerElement;

    rerender(<OctosSkinArt skin="panda-3d" reactionKey={1} />);
    act(() => {
      viewer.loaded = true;
      viewer.dispatchEvent(new Event("load"));
    });

    expect(
      viewer.play.mock.calls.filter(
        ([options]) => options?.repetitions === 1,
      ),
    ).toHaveLength(0);

    rerender(<OctosSkinArt skin="panda-3d" reactionKey={2} />);
    expect(
      viewer.play.mock.calls.filter(
        ([options]) => options?.repetitions === 1,
      ),
    ).toHaveLength(1);
  });

  it("responds to reduced-motion changes while the model is mounted", () => {
    enableWebGl();
    const reducedMotion = installReducedMotionQuery();
    const { container } = render(<OctosSkinArt skin="panda-3d" />);
    const viewer = container.querySelector(
      "model-viewer",
    ) as FakeModelViewerElement;

    act(() => {
      viewer.loaded = true;
      viewer.dispatchEvent(new Event("load"));
    });
    viewer.play.mockClear();

    act(() => reducedMotion.setMatches(true));
    expect(viewer.pause).toHaveBeenCalledOnce();

    act(() => reducedMotion.setMatches(false));
    expect(viewer.play).toHaveBeenCalledOnce();
  });
});
