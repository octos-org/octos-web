/**
 * Tests for issue #993 — site-preview iframe XSS bridge fix.
 *
 * The bug: `src/sites/components/site-preview.tsx` rendered the preview
 * iframe with NO `sandbox` attribute. Because `API_BASE === ""` in
 * `src/lib/constants.ts`, the preview loads same-origin with the SPA.
 * Tokens stored in `localStorage` (`octos_session_token` +
 * `octos_auth_token`) are therefore reachable from inside the iframe via
 * `window.parent.localStorage` — any LLM-authored HTML/JS in the preview
 * can exfiltrate them.
 *
 * Codex recommended Option A: add `sandbox` without `allow-same-origin`.
 * This file pins that choice:
 *
 *   1. iframe MUST have a `sandbox` attribute (anti-regression)
 *   2. sandbox attribute MUST include `allow-scripts` + `allow-forms`
 *   3. sandbox attribute MUST NOT include `allow-same-origin` (the
 *      whole point — granting it defeats the fix)
 *   4. `handleLoad` MUST NOT throw when `iframe.contentDocument` is
 *      blocked by the sandbox (the previous title-sniff path read it)
 *   5. The "Open preview in new tab" anchor MUST be removed — opening
 *      the same-origin URL as a top-level doc still exposes tokens.
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

import { SitePreview } from "./site-preview";

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

function queryIframe(container: HTMLElement): HTMLIFrameElement | null {
  return container.querySelector("iframe");
}

const baseProps = {
  previewUrl: "/api/preview/profile/session/slug/index.html",
  siteName: "Demo Site",
  template: "Next.js",
  sessionId: "session-123",
};

beforeEach(() => {
  // Ensure a clean DOM for each test.
  for (const node of [...document.body.children]) {
    node.remove();
  }
});

afterEach(() => {
  for (const node of [...document.body.children]) {
    node.remove();
  }
});

describe("SitePreview — issue #993 iframe sandbox (XSS bridge fix)", () => {
  it("renders iframe with a `sandbox` attribute (anti-regression)", () => {
    const { container, unmount } = mount(<SitePreview {...baseProps} />);
    try {
      const iframe = queryIframe(container);
      expect(iframe).not.toBeNull();
      // Pre-fix failure mode: `iframe.getAttribute("sandbox") === null`.
      // This is the headline regression guard for issue #993.
      expect(iframe?.getAttribute("sandbox")).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('iframe sandbox attribute equals "allow-scripts allow-forms"', () => {
    const { container, unmount } = mount(<SitePreview {...baseProps} />);
    try {
      const iframe = queryIframe(container);
      const sandboxAttr = iframe?.getAttribute("sandbox") ?? "";
      expect(sandboxAttr).toBe("allow-scripts allow-forms");
    } finally {
      unmount();
    }
  });

  it("iframe sandbox includes `allow-scripts`", () => {
    const { container, unmount } = mount(<SitePreview {...baseProps} />);
    try {
      const iframe = queryIframe(container);
      const tokens = (iframe?.getAttribute("sandbox") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      expect(tokens).toContain("allow-scripts");
    } finally {
      unmount();
    }
  });

  it("iframe sandbox includes `allow-forms`", () => {
    const { container, unmount } = mount(<SitePreview {...baseProps} />);
    try {
      const iframe = queryIframe(container);
      const tokens = (iframe?.getAttribute("sandbox") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      expect(tokens).toContain("allow-forms");
    } finally {
      unmount();
    }
  });

  it("iframe sandbox MUST NOT include `allow-same-origin` (defeats the fix)", () => {
    const { container, unmount } = mount(<SitePreview {...baseProps} />);
    try {
      const iframe = queryIframe(container);
      const tokens = (iframe?.getAttribute("sandbox") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      // This is the explicit anti-assertion called out in issue #993.
      // Granting `allow-same-origin` here would re-enable
      // `window.parent.localStorage` reads from inside the iframe and
      // re-open the XSS bridge.
      expect(tokens).not.toContain("allow-same-origin");
    } finally {
      unmount();
    }
  });

  it("handleLoad does not throw when iframe.contentDocument access is blocked", () => {
    const { container, unmount } = mount(<SitePreview {...baseProps} />);
    try {
      const iframe = queryIframe(container);
      expect(iframe).not.toBeNull();

      // Simulate the cross-origin-blocked case: a real sandboxed
      // iframe with no `allow-same-origin` returns `null` from
      // `contentDocument`; some browsers throw `SecurityError`. We
      // install a getter that throws to model the worst case — the
      // load handler MUST be resilient.
      if (iframe) {
        Object.defineProperty(iframe, "contentDocument", {
          configurable: true,
          get(): Document | null {
            throw new DOMException("Blocked a frame", "SecurityError");
          },
        });
      }

      // Pre-fix `handleLoad` read `frame.contentDocument?.title` which
      // would throw under the getter above. Post-fix it ignores the
      // frame entirely.
      expect(() => {
        act(() => {
          iframe?.dispatchEvent(new Event("load"));
        });
      }).not.toThrow();
    } finally {
      unmount();
    }
  });

  it("does NOT render an `Open preview in new tab` link", () => {
    const { container, unmount } = mount(<SitePreview {...baseProps} />);
    try {
      // The link was an `<a target="_blank" rel="noreferrer">` pointing
      // at the same-origin preview URL. Opening it as a top-level
      // document hands the LLM-authored HTML full `localStorage`
      // access, so it's removed until the signed-URL endpoint ships.
      const externalLink = container.querySelector(
        'a[target="_blank"]',
      );
      expect(externalLink).toBeNull();

      // Defensive: also assert there is no anchor whose href matches
      // the preview URL, in case a future refactor swaps the
      // target/_blank attribute for something else.
      const anchors = container.querySelectorAll("a[href]");
      for (const a of anchors) {
        expect(a.getAttribute("href")).not.toBe(baseProps.previewUrl);
      }
    } finally {
      unmount();
    }
  });
});
