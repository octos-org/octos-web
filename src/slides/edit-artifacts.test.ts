import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hydrateSlidesProjectFromSession, slideEditsAreRendered, type SlidesFileEntry, type SlidesRenderManifest } from "./api";
import type { SlideEditDocument } from "./types";

vi.mock("@/api/sessions", () => ({ getSessionFiles: vi.fn(async () => []), listSessions: vi.fn(async () => []) }));
const document: SlideEditDocument = {
  revision: "revision-2", savedAt: "2026-09-10T12:00:00Z", baseGeneratedAt: null,
  slides: [{ index: 0, title: "Saved edit", notes: "New notes", layout: "title" }],
};
const file = (filename: string, group = "skill-output/slides/deck/output"): SlidesFileEntry => ({
  filename, group, path: `pf/handle/${filename}`, size: 100, modified: "2026-09-10T12:01:00Z", category: "slides",
});
const files = [file("slide-01.png"), file("deck.pptx"), file("manual-edits-applied.json", "slides/deck")];
const manifest: SlidesRenderManifest = {
  version: 0, generatedAt: "new", slideDir: files[0].group, outFile: files[1].path, slideCount: 1,
  slides: [{ index: 0, filename: files[0].filename, path: files[0].path }], manifestPath: "",
};
beforeEach(() => { localStorage.clear(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => vi.unstubAllGlobals());

it("requires the exact saved revision even when every output is fresh", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ revision: "revision-1" })));
  expect(await slideEditsAreRendered("deck", document, manifest, files)).toBe(false);
});

it("accepts the matching revision only with all fresh PNG and PPTX bytes", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ revision: document.revision })));
  expect(await slideEditsAreRendered("deck", document, manifest, files)).toBe(true);
  for (const staleIndex of [0, 1]) {
    const stale = files.map((entry, index) => index === staleIndex ? { ...entry, modified: "2026-09-10T11:00:00Z" } : entry);
    expect(await slideEditsAreRendered("deck", document, manifest, stale)).toBe(false);
  }
  expect(await slideEditsAreRendered("deck", document, manifest, files.slice(0, 1))).toBe(false);
});

it("restores pending edits in a fresh browser without declaring the old export current", async () => {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/files/list?")) return new Response(JSON.stringify(files.slice(0, 2)));
    if (url.includes("/api/slides/edits?")) return new Response(JSON.stringify(document));
    throw new Error(`Unexpected request ${url}`);
  });
  const project = await hydrateSlidesProjectFromSession("slides-saved");
  expect(project?.slides).toEqual(document.slides);
  expect(project?.manualEdits?.revision).toBe(document.revision);
  expect(project?.appliedEditRevision).toBeUndefined();
  expect(project?.pptxPath).toBe(files[1].path);
});
