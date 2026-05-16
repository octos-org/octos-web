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
});
