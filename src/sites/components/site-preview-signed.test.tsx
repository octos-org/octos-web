/**
 * `<SitePreview>` signed-URL iframe tests (#1001 follow-up).
 *
 * After PR #1001 the preview iframe at
 * `<iframe src=/api/preview/{profile_id}/{session_id}/{slug}/index.html>`
 * 401s because iframes don't send `Authorization`. The new contract:
 *
 *   1. On mount, the component calls `signPreview()` with the active
 *      site coordinates and sets `iframe.src = response.preview_url`.
 *   2. It schedules a renewal at `expires_at - 60s`, calling
 *      `signPreview()` again and swapping `iframe.src` to the new URL.
 *   3. If the sign call rejects (e.g. 403 for cross-tenant attempt),
 *      the component shows an error UI and DOES NOT render the iframe.
 *
 * These three behaviours are exactly what the codex follow-up asked for
 * — no rewrite of relative paths, no fallback to the legacy preview
 * URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Mock the api module BEFORE importing the component so the SUT's
// `import { signPreview } from "../api"` picks up the mock. `vi.mock`
// is hoisted to the top of the file by vitest's transformer — so we
// can NOT reference outer `let/const` from inside the factory. Use
// `vi.hoisted` to create the mock function above the hoist line.
const { signPreviewMock } = vi.hoisted(() => ({
  signPreviewMock: vi.fn(),
}));
vi.mock("../api", () => ({
  signPreview: signPreviewMock,
  buildSitePreviewUrl: vi.fn(() => "/legacy/should-not-be-used"),
}));

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

const SIGNED_TOKEN = "a".repeat(64);
const SIGNED_URL = `/api/preview-signed/${SIGNED_TOKEN}/index.html`;
const RENEWAL_URL = `/api/preview-signed/${"b".repeat(64)}/index.html`;

beforeEach(() => {
  vi.useFakeTimers();
  signPreviewMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  for (const node of [...document.body.children]) {
    node.remove();
  }
});

describe("<SitePreview> signed-URL iframe", () => {
  it("calls signPreview on mount and sets iframe.src to the returned preview_url", async () => {
    const now = Date.now();
    signPreviewMock.mockResolvedValueOnce({
      token: SIGNED_TOKEN,
      preview_url: SIGNED_URL,
      expires_at: new Date(now + 600_000).toISOString(),
    });

    let harness!: MountedHarness;
    await act(async () => {
      harness = mount(
        <SitePreview
          previewUrl="ignored-by-signed-flow"
          siteName="Test Site"
          template="astro-site"
          sessionId="site-A-1234567890"
          profileId="tenant-a"
          slug="test-site"
        />,
      );
      // Flush the awaited signPreview promise.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(signPreviewMock).toHaveBeenCalledTimes(1);
    expect(signPreviewMock).toHaveBeenCalledWith({
      profile_id: "tenant-a",
      session_id: "site-A-1234567890",
      site_slug: "test-site",
    });

    const iframe = harness.container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toContain(SIGNED_URL);

    harness.unmount();
  });

  it("schedules a renewal at expires_at - 60s and updates iframe.src", async () => {
    const now = Date.now();
    vi.setSystemTime(now);
    // First mint: expires in 5 seconds so the test doesn't have to
    // advance the clock by 9 minutes.
    signPreviewMock
      .mockResolvedValueOnce({
        token: SIGNED_TOKEN,
        preview_url: SIGNED_URL,
        expires_at: new Date(now + 5_000).toISOString(),
      })
      .mockResolvedValueOnce({
        token: "b".repeat(64),
        preview_url: RENEWAL_URL,
        expires_at: new Date(now + 605_000).toISOString(),
      });

    let harness!: MountedHarness;
    await act(async () => {
      harness = mount(
        <SitePreview
          previewUrl="ignored"
          siteName="Test Site"
          template="astro-site"
          sessionId="site-A"
          profileId="tenant-a"
          slug="test-site"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(signPreviewMock).toHaveBeenCalledTimes(1);
    const iframe = harness.container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toContain(SIGNED_URL);

    // The renewal scheduler subtracts 60 s from expires_at; with a
    // 5-second TTL and a 60-second renewal window the timer fires
    // immediately (the helper clamps to a minimum positive value).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      // Flush the renewal sign promise.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(signPreviewMock).toHaveBeenCalledTimes(2);
    const refreshedIframe = harness.container.querySelector("iframe");
    expect(refreshedIframe?.getAttribute("src")).toContain(RENEWAL_URL);

    harness.unmount();
  });

  it("shows an error UI when signPreview rejects (e.g. 403 cross-tenant)", async () => {
    signPreviewMock.mockRejectedValueOnce(new Error("HTTP 403"));

    let harness!: MountedHarness;
    await act(async () => {
      harness = mount(
        <SitePreview
          previewUrl="ignored"
          siteName="Test Site"
          template="astro-site"
          sessionId="site-A"
          profileId="tenant-b"
          slug="test-site"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.container.querySelector("iframe")).toBeNull();
    expect(
      harness.container.querySelector(
        "[data-testid='site-preview-error']",
      ),
    ).not.toBeNull();

    harness.unmount();
  });

  /**
   * Codex GAP 2 — stale signPreview response after unmount.
   *
   * If `signPreview()` resolves AFTER the component unmounts, the
   * resolution handler must NOT call `setState` (no-op warning in
   * React 19) and MUST NOT schedule a renewal timer. The latest-wins
   * guard in `refreshSignedToken` short-circuits because the unmount
   * cleanup bumps `signReqId.current`, so the captured `myReqId`
   * differs from the live value.
   */
  it("drops the stale signPreview response when the component unmounts before it resolves", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    // Slow sign — kept in a deferred so we can resolve it AFTER unmount.
    let resolveSign!: (value: {
      token: string;
      preview_url: string;
      expires_at: string;
    }) => void;
    signPreviewMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSign = resolve;
        }),
    );

    let harness!: MountedHarness;
    await act(async () => {
      harness = mount(
        <SitePreview
          previewUrl="ignored"
          siteName="Test Site"
          template="astro-site"
          sessionId="site-A"
          profileId="tenant-a"
          slug="test-site"
        />,
      );
      // signPreview is invoked but does NOT resolve yet.
      await Promise.resolve();
    });
    expect(signPreviewMock).toHaveBeenCalledTimes(1);

    // Snapshot the active-timer count so we can prove no renewal was
    // scheduled by the stale resolution. With `vi.useFakeTimers()` the
    // count is observable via `vi.getTimerCount()`.
    const timersBeforeUnmount = vi.getTimerCount();

    // Unmount THEN resolve the sign. With the latest-wins guard,
    // the unmount cleanup bumps `signReqId.current` so the captured
    // `myReqId` no longer matches — the resolution bails before
    // touching state or scheduling a renewal.
    harness.unmount();

    await act(async () => {
      resolveSign({
        token: SIGNED_TOKEN,
        preview_url: SIGNED_URL,
        expires_at: new Date(now + 600_000).toISOString(),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    // No new timers (i.e. no renewal scheduled by the stale response).
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeUnmount);
    // The unmounted container has no iframe — the stale setState was
    // dropped, so no React warning + no leaked state.
    expect(harness.container.querySelector("iframe")).toBeNull();
  });

  /**
   * Codex GAP 3 — rapid re-render race.
   *
   * Three previews fire in quick succession before any resolves. Only
   * the THIRD signed URL must end up in the iframe.src — earlier
   * resolutions are dropped because their captured `myReqId` is stale.
   */
  it("handles rapid preview changes — only the latest signPreview wins", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    // Three previews, three URLs. We deliberately resolve out of
    // order: 3rd first, then 1st, then 2nd. The latest-wins guard
    // must accept only the 3rd's result.
    const urls = [
      `/api/preview-signed/${"1".repeat(64)}/index.html`,
      `/api/preview-signed/${"2".repeat(64)}/index.html`,
      `/api/preview-signed/${"3".repeat(64)}/index.html`,
    ];
    const deferreds: Array<(value: {
      token: string;
      preview_url: string;
      expires_at: string;
    }) => void> = [];
    signPreviewMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferreds.push(resolve);
        }),
    );

    let harness!: MountedHarness;
    await act(async () => {
      harness = mount(
        <SitePreview
          previewUrl="ignored"
          siteName="Test Site"
          template="astro-site"
          sessionId="site-A"
          profileId="tenant-a"
          slug="slug-1"
        />,
      );
      await Promise.resolve();
    });
    // Re-render with two more slugs in succession. Each prop change
    // re-runs the `useEffect` that calls `refreshSignedToken()`,
    // bumping `signReqId.current` and capturing a fresh `myReqId`.
    await act(async () => {
      harness.root.render(
        <SitePreview
          previewUrl="ignored"
          siteName="Test Site"
          template="astro-site"
          sessionId="site-A"
          profileId="tenant-a"
          slug="slug-2"
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      harness.root.render(
        <SitePreview
          previewUrl="ignored"
          siteName="Test Site"
          template="astro-site"
          sessionId="site-A"
          profileId="tenant-a"
          slug="slug-3"
        />,
      );
      await Promise.resolve();
    });

    // We expect THREE in-flight signs.
    expect(signPreviewMock).toHaveBeenCalledTimes(3);
    expect(deferreds.length).toBe(3);

    // Resolve out of order: 3rd, then 1st, then 2nd.
    await act(async () => {
      deferreds[2]({
        token: "3".repeat(64),
        preview_url: urls[2],
        expires_at: new Date(now + 600_000).toISOString(),
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    // After the latest resolves, the iframe must point at urls[2].
    let iframe = harness.container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toContain(urls[2]);

    // Now resolve the stale 1st and 2nd. They must NOT clobber the
    // iframe — the latest-wins guard drops them.
    await act(async () => {
      deferreds[0]({
        token: "1".repeat(64),
        preview_url: urls[0],
        expires_at: new Date(now + 600_000).toISOString(),
      });
      deferreds[1]({
        token: "2".repeat(64),
        preview_url: urls[1],
        expires_at: new Date(now + 600_000).toISOString(),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    iframe = harness.container.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toContain(urls[2]);
    expect(iframe?.getAttribute("src")).not.toContain(urls[0]);
    expect(iframe?.getAttribute("src")).not.toContain(urls[1]);

    harness.unmount();
  });

  /**
   * Codex GAP 5 — iframe sandbox attribute (mirrors PR #139's #993
   * test). The preview is same-origin with the SPA; without `sandbox`
   * the LLM-authored HTML in the preview can read
   * `window.parent.localStorage` and exfiltrate auth tokens. The
   * sandbox attribute must equal `"allow-scripts allow-forms"`
   * (NOT `allow-same-origin` — that defeats the fix).
   */
  it("renders iframe with sandbox=\"allow-scripts allow-forms\" (issue #993 / PR #139)", async () => {
    const now = Date.now();
    signPreviewMock.mockResolvedValueOnce({
      token: SIGNED_TOKEN,
      preview_url: SIGNED_URL,
      expires_at: new Date(now + 600_000).toISOString(),
    });

    let harness!: MountedHarness;
    await act(async () => {
      harness = mount(
        <SitePreview
          previewUrl="ignored"
          siteName="Test Site"
          template="astro-site"
          sessionId="site-A"
          profileId="tenant-a"
          slug="test-site"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const iframe = harness.container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const sandboxAttr = iframe?.getAttribute("sandbox") ?? "";
    expect(sandboxAttr).toBe("allow-scripts allow-forms");

    // Anti-regression for the headline #993 anti-assertion: granting
    // `allow-same-origin` here would re-enable
    // `window.parent.localStorage` reads from inside the iframe.
    const tokens = sandboxAttr.split(/\s+/).filter(Boolean);
    expect(tokens).toContain("allow-scripts");
    expect(tokens).toContain("allow-forms");
    expect(tokens).not.toContain("allow-same-origin");

    harness.unmount();
  });

  /**
   * Codex round-3 HIGH — StrictMode double-mount / remount cycle.
   *
   * Pre-fixup bug (`site-preview.tsx:199`): the cleanup set
   * `mounted.current = false` but never reset it to `true` on the
   * next mount. React 19 StrictMode (`main.tsx`) runs effects twice
   * in dev — mount → cleanup → mount-again. The first cleanup
   * flipped `mounted.current` to `false`; the second mount ran
   * without resetting it, so every `signPreview` resolution was
   * silently dropped by the `!mounted.current` short-circuit in the
   * latest-wins guard. The iframe was stuck on "Loading preview…"
   * forever in dev.
   *
   * Post-fixup the `mounted` ref is removed entirely. The cleanup
   * bumps `signReqId.current`, which is sufficient to invalidate
   * in-flight resolutions; the next mount captures a fresh id and
   * succeeds. We simulate StrictMode by wrapping the SUT in
   * `<StrictMode>` so React runs the dev-only mount → cleanup →
   * mount cycle.
   */
  it("should_recover_after_unmount_remount_cycle (StrictMode regression)", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    // Two resolutions because StrictMode causes the effect to run
    // twice — both must complete, but only the second matters for
    // the rendered iframe. We give them distinct URLs so we can tell
    // which one landed.
    signPreviewMock.mockResolvedValue({
      token: SIGNED_TOKEN,
      preview_url: SIGNED_URL,
      expires_at: new Date(now + 600_000).toISOString(),
    });

    let harness!: MountedHarness;
    await act(async () => {
      harness = mount(
        <React.StrictMode>
          <SitePreview
            previewUrl="ignored"
            siteName="Test Site"
            template="astro-site"
            sessionId="site-A"
            profileId="tenant-a"
            slug="test-site"
          />
        </React.StrictMode>,
      );
      // Flush both passes of StrictMode's mount → cleanup → mount.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Pre-fixup: the iframe is absent because every signPreview
    // resolution is dropped by the stale `!mounted.current` check.
    // Post-fixup: the iframe renders against SIGNED_URL.
    const iframe = harness.container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toContain(SIGNED_URL);

    harness.unmount();
  });
});
