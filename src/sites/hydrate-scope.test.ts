/**
 * Regression tests for `hydrateSiteProjectFromSession` session scoping.
 *
 * Bug (2026-06-08): a brand-new site session, before it scaffolds,
 * would "adopt" an unrelated session's scaffolded site. The cause was
 * a fallback in `hydrateSiteProjectFromSession` that re-listed
 * `sites/` WITHOUT a `session_id`, and the backend's unscoped
 * `/api/files/list` returns `sites/` across ALL sessions of the
 * profile. The first foreign `physics-learning-studio` (a
 * quarto-lesson) got adopted, so the user's react-vite selection was
 * silently replaced by quarto and `ensureSiteScaffolded` short-
 * circuited before ever sending `/new site react`.
 *
 * Contract: a session may only hydrate from ITS OWN workspace. If the
 * session-scoped listing finds nothing, hydrate returns null and the
 * caller scaffolds fresh — it must never query files without a
 * session scope.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  buildApiHeaders: vi.fn(
    (extras: Record<string, string> = {}, profileId?: string | null) => ({
      ...extras,
      ...(profileId ? { "X-Profile-Id": profileId } : {}),
    }),
  ),
  ensureSelectedProfileId: vi.fn(async () => "tenant-a"),
  getSelectedProfileId: vi.fn(() => "tenant-a"),
}));

import { hydrateSiteProjectFromSession } from "./api";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("hydrateSiteProjectFromSession session scoping", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("does not adopt another session's scaffolded site", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/files/list")) {
        if (url.includes("session_id=")) {
          // This session's own workspace has no site yet.
          return json([]);
        }
        // Unscoped listing would leak a foreign session's site.
        return json([
          {
            filename: "mofa-site-session.json",
            path: "users/site-OTHER-999/workspace/sites/physics-learning-studio/mofa-site-session.json",
            size: 10,
            modified: "2026-06-08T00:00:00Z",
            category: "report",
            group: "sites/physics-learning-studio",
          },
        ]);
      }
      // Foreign metadata — only fetched if the bug adopts the site.
      return json({
        template: "quarto-lesson",
        site_slug: "physics-learning-studio",
        site_name: "Physics Learning Studio",
      });
    }) as typeof fetch;

    const result = await hydrateSiteProjectFromSession("site-NEW-123", "tenant-a");

    expect(result).toBeNull();

    const queriedWithoutSession = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).mock.calls
      .map(([u]) => String(u))
      .some((u) => u.includes("/api/files/list") && !u.includes("session_id="));
    expect(queriedWithoutSession).toBe(false);
  });

  it("adopts the site found in this session's own workspace", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/files/list")) {
        return json([
          {
            filename: "mofa-site-session.json",
            path: "users/site-NEW-123/workspace/sites/react-lab/mofa-site-session.json",
            size: 10,
            modified: "2026-06-08T00:00:00Z",
            category: "report",
            group: "sites/react-lab",
          },
        ]);
      }
      return json({
        template: "react-vite",
        site_slug: "react-lab",
        site_name: "React Lab",
        site_kind: "tool",
        preview_url: "/api/preview/tenant-a/site-NEW-123/react-lab/index.html",
      });
    }) as typeof fetch;

    const result = await hydrateSiteProjectFromSession("site-NEW-123", "tenant-a");

    expect(result?.slug).toBe("react-lab");
    expect(result?.template).toBe("react-vite");
  });
});
