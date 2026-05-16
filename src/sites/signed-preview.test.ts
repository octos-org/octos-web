/**
 * Tests for the signed-preview API helper introduced as the
 * follow-up to PR #1001.
 *
 * Background
 * ----------
 * PR #1001 closed the cross-tenant `/api/preview/{profile_id}/...`
 * data-read by requiring `Authorization: Bearer ...` on every
 * request. That regressed the SPA iframe UX because the iframe
 * tag cannot inject headers — the iframe 401-loops after the
 * dashboard tab loads.
 *
 * Codex's design (verbatim in the issue thread): the SPA mints an
 * opaque token via `POST /api/my/preview/sign` (which DOES send the
 * bearer) and points `iframe.src` at the returned signed URL
 * `/api/preview-signed/{token}/index.html`. The token is the auth
 * credential for the iframe GETs.
 *
 * These tests pin the contract for the small `signPreview` helper:
 *   - POSTs to `/api/my/preview/sign` with the correct body
 *   - sends `Authorization` + `X-Profile-Id` via `buildApiHeaders`
 *   - returns `{token, preview_url, expires_at}` on 2xx
 *   - throws on 4xx
 *
 * The renewal scheduling behaviour is exercised by the iframe
 * component tests under
 * `src/sites/components/site-preview-signed.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  buildApiHeaders: vi.fn(
    (extras: Record<string, string> = {}, profileId?: string | null) => ({
      ...extras,
      Authorization: "Bearer TEST-BEARER",
      ...(profileId ? { "X-Profile-Id": profileId } : {}),
    }),
  ),
  ensureSelectedProfileId: vi.fn(async () => "tenant-a"),
  getSelectedProfileId: vi.fn(() => "tenant-a"),
}));

import { signPreview } from "./api";

describe("signPreview", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("POSTs the canonical body to /api/my/preview/sign", async () => {
    const expiresAt = "2026-05-16T13:30:00.000Z";
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          preview_url:
            "/api/preview-signed/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/index.html",
          expires_at: expiresAt,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await signPreview({
      profile_id: "tenant-a",
      session_id: "site-A-1234567890",
      site_slug: "test-site",
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("/api/my/preview/sign");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer TEST-BEARER",
      "X-Profile-Id": "tenant-a",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      profile_id: "tenant-a",
      session_id: "site-A-1234567890",
      site_slug: "test-site",
    });

    expect(result).toEqual({
      token:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      preview_url:
        "/api/preview-signed/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/index.html",
      expires_at: expiresAt,
    });
  });

  it("throws on 4xx so the iframe component can surface an error UI", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    );

    await expect(
      signPreview({
        profile_id: "tenant-b",
        session_id: "site-Z",
        site_slug: "test-site",
      }),
    ).rejects.toThrow(/403/);
  });

  it("throws on 401 (sign endpoint requires auth)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );

    await expect(
      signPreview({
        profile_id: "tenant-a",
        session_id: "site-A-1234567890",
        site_slug: "test-site",
      }),
    ).rejects.toThrow(/401/);
  });
});
