/**
 * Tests for the slides preview directory discovery fix.
 *
 * Background
 * ----------
 * The mofa-slides skill writes PNG previews + `manifest.json` to
 * `workspace/skill-output/slides/<slug>/output/imgs/`. The earlier
 * implementation only asked the file-list API for
 * `workspace/slides/<slug>/`, so the SPA never saw those PNGs and
 * fell through to the placeholder gradient even when the deck
 * preview was on disk.
 *
 * The asymmetry was visible: the side file-tree at
 * `src/slides/components/project-files.tsx:279` already requested
 * BOTH `slides/<slug>` AND `skill-output`, which is why thumbnails
 * appeared there. These tests pin the preview pipeline to the same
 * dual-dir contract.
 *
 * Coverage:
 *   1. `resolveSlidesManifestPath` matches `manifest.json` under the
 *      legacy `slides/<slug>/output/imgs/` group (regression).
 *   2. `resolveSlidesManifestPath` matches `manifest.json` under the
 *      new `skill-output/slides/<slug>/output/imgs/` group (the fix).
 *   3. `hydrateSlidesProjectCandidate` requests BOTH `slides` and
 *      `skill-output/slides` from the file-list endpoint, so the
 *      hydration path picks up skill-output PNGs.
 *
 * Paired with the recent slides P0-A fix on octos main (a303991c)
 * — together they close the user-visible "deck button works but
 * preview shows no images" UX gap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  buildApiHeaders: vi.fn(() => ({ Authorization: "Bearer TEST" })),
  getToken: vi.fn(() => "TEST"),
  ensureSelectedProfileId: vi.fn(async () => "tenant-a"),
  getSelectedProfileId: vi.fn(() => "tenant-a"),
}));

vi.mock("@/api/sessions", () => ({
  getSessionFiles: vi.fn(async () => []),
  getSessionWorkspaceContract: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
}));

import {
  fetchSlidesManifest,
  hydrateSlidesProjectFromSession,
  listSlidesFiles,
  type SlidesFileEntry,
} from "./api";

const SLUG = "fiba-2027-deck-abc123";

function pngEntryUnder(dir: string, index: number): SlidesFileEntry {
  const filename = `slide_${String(index).padStart(3, "0")}.png`;
  return {
    filename,
    path: `pf/opaque-handle/${filename}`,
    size: 1024,
    modified: "2026-05-25T00:00:00Z",
    category: "image",
    group: dir,
  };
}

function manifestEntry(dir: string): SlidesFileEntry {
  return {
    filename: "manifest.json",
    path: `pf/opaque-handle/manifest.json`,
    size: 256,
    modified: "2026-05-25T00:00:00Z",
    category: "report",
    group: dir,
  };
}

describe("resolveSlidesManifestPath (via fetchSlidesManifest)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("matches manifest under legacy slides/<slug>/output/imgs", async () => {
    const legacyDir = `slides/${SLUG}/output/imgs`;
    const files: SlidesFileEntry[] = [
      manifestEntry(legacyDir),
      pngEntryUnder(legacyDir, 1),
      pngEntryUnder(legacyDir, 2),
    ];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        version: 1,
        generated_at: "2026-05-25T00:00:00Z",
        slide_dir: legacyDir,
        out_file: `slides/${SLUG}/output/deck.pptx`,
        slide_count: 2,
        slides: [
          { index: 0, filename: "slide_001.png", path: "slide_001.png" },
          { index: 1, filename: "slide_002.png", path: "slide_002.png" },
        ],
      }),
    });

    const manifest = await fetchSlidesManifest(SLUG, files);
    expect(manifest).not.toBeNull();
    expect(manifest!.slideCount).toBe(2);
    expect(manifest!.slides).toHaveLength(2);
  });

  it("matches manifest under skill-output/slides/<slug>/output/imgs (the fix)", async () => {
    const newDir = `skill-output/slides/${SLUG}/output/imgs`;
    const files: SlidesFileEntry[] = [
      manifestEntry(newDir),
      pngEntryUnder(newDir, 1),
      pngEntryUnder(newDir, 2),
      pngEntryUnder(newDir, 3),
    ];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        version: 1,
        generated_at: "2026-05-25T00:00:00Z",
        slide_dir: newDir,
        out_file: `skill-output/slides/${SLUG}/output/deck.pptx`,
        slide_count: 3,
        slides: [
          { index: 0, filename: "slide_001.png", path: "slide_001.png" },
          { index: 1, filename: "slide_002.png", path: "slide_002.png" },
          { index: 2, filename: "slide_003.png", path: "slide_003.png" },
        ],
      }),
    });

    const manifest = await fetchSlidesManifest(SLUG, files);
    expect(manifest).not.toBeNull();
    expect(manifest!.slideCount).toBe(3);
    expect(manifest!.slides).toHaveLength(3);
  });

  it("returns null when files contain neither legacy nor skill-output manifest", async () => {
    const files: SlidesFileEntry[] = [
      // A file under an unrelated directory.
      {
        filename: "memory.md",
        path: "pf/opaque-handle/memory.md",
        size: 32,
        modified: "2026-05-25T00:00:00Z",
        category: "report",
        group: `slides/${SLUG}`,
      },
    ];

    const manifest = await fetchSlidesManifest(SLUG, files);
    expect(manifest).toBeNull();
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("listSlidesFiles dual-dir queries", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("forwards both legacy and skill-output dirs to /api/files/list", async () => {
    await listSlidesFiles([`slides/${SLUG}`, `skill-output/slides/${SLUG}`], {
      sessionId: "session-1",
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const url = calls[0][0] as string;
    expect(url).toContain(`dirs=slides%2F${SLUG}%2Cskill-output%2Fslides%2F${SLUG}`);
    expect(url).toContain("session_id=session-1");
  });
});

describe("hydrateSlidesProjectFromSession", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("requests both slides and skill-output/slides dirs when hydrating", async () => {
    const sessionId = `slides-${Date.now()}-aaa111`;
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // First call: GET /api/files/list — return empty so we don't proceed
    // to manifest fetch, but assert the URL carried both dirs.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });

    await hydrateSlidesProjectFromSession(sessionId);

    expect(fetchMock).toHaveBeenCalled();
    const firstCallUrl = fetchMock.mock.calls[0][0] as string;
    // The hydration path uses `listSlidesFiles("slides", ...)` historically;
    // the fix changes it to include the skill-output sibling so the
    // candidate picks up the new layout.
    expect(firstCallUrl).toMatch(/dirs=.*skill-output%2Fslides/);
    expect(firstCallUrl).toMatch(/dirs=.*slides(?:%2C|$)/);
  });

  it("hydrates a project when only skill-output PNGs are on disk", async () => {
    const sessionId = `slides-${Date.now()}-bbb222`;
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const newDir = `skill-output/slides/${SLUG}/output/imgs`;
    const files: SlidesFileEntry[] = [
      manifestEntry(newDir),
      pngEntryUnder(newDir, 1),
      pngEntryUnder(newDir, 2),
    ];

    // 1. /api/files/list — returns skill-output PNGs + manifest.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => files,
    });
    // 2. manifest fetch via buildFileUrl.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        version: 1,
        generated_at: "2026-05-25T00:00:00Z",
        slide_dir: newDir,
        out_file: `skill-output/slides/${SLUG}/output/deck.pptx`,
        slide_count: 2,
        slides: [
          { index: 0, filename: "slide_001.png", path: "slide_001.png" },
          { index: 1, filename: "slide_002.png", path: "slide_002.png" },
        ],
      }),
    });

    const project = await hydrateSlidesProjectFromSession(sessionId);
    expect(project).not.toBeNull();
    expect(project!.slug).toBe(SLUG);
    expect(project!.slides).toHaveLength(2);
  });
});
