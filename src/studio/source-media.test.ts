import { describe, expect, it } from "vitest";

import {
  mergeSourceMedia,
  relativeTime,
  sourcePreviewPath,
  sourceKind,
  sourceRowFromSkillActionJob,
} from "./source-media";

describe("mergeSourceMedia", () => {
  it("returns original media first, then selected sources", () => {
    expect(
      mergeSourceMedia(["a.png", "b.pdf"], ["research/c.md", "research/d.md"]),
    ).toEqual(["a.png", "b.pdf", "research/c.md", "research/d.md"]);
  });

  it("drops selected paths already present in media", () => {
    expect(mergeSourceMedia(["a.png", "b.pdf"], ["b.pdf", "c.md"])).toEqual([
      "a.png",
      "b.pdf",
      "c.md",
    ]);
  });

  it("dedupes within each input list", () => {
    expect(mergeSourceMedia(["a.png", "a.png"], ["c.md", "c.md"])).toEqual([
      "a.png",
      "c.md",
    ]);
  });

  it("handles empty media", () => {
    expect(mergeSourceMedia([], ["c.md"])).toEqual(["c.md"]);
  });

  it("handles empty selected", () => {
    expect(mergeSourceMedia(["a.png"], [])).toEqual(["a.png"]);
  });

  it("handles both empty", () => {
    expect(mergeSourceMedia([], [])).toEqual([]);
  });

  it("skips empty-string paths", () => {
    expect(mergeSourceMedia(["", "a.png"], ["", "c.md"])).toEqual([
      "a.png",
      "c.md",
    ]);
  });

  it("does not mutate its inputs", () => {
    const media = ["a.png"];
    const selected = ["c.md"];
    mergeSourceMedia(media, selected);
    expect(media).toEqual(["a.png"]);
    expect(selected).toEqual(["c.md"]);
  });
});

describe("sourceKind", () => {
  it("classifies known extensions", () => {
    expect(sourceKind("photo.PNG")).toBe("image");
    expect(sourceKind("clip.webp")).toBe("image");
    expect(sourceKind("song.mp3")).toBe("audio");
    expect(sourceKind("take.m4a")).toBe("audio");
    expect(sourceKind("movie.mov")).toBe("video");
    expect(sourceKind("data.csv")).toBe("table");
    expect(sourceKind("book.xlsx")).toBe("table");
  });

  it("defaults to text for unknown or missing extensions", () => {
    expect(sourceKind("notes.md")).toBe("text");
    expect(sourceKind("README")).toBe("text");
    expect(sourceKind("archive.")).toBe("text");
  });
});

describe("sourceRowFromSkillActionJob", () => {
  it("keeps the normalized source path for grounding and the original file path for preview", () => {
    const row = sourceRowFromSkillActionJob({
      job_id: "job-photo",
      batch_id: "batch-photo",
      profile_id: "alan0x",
      session_id: "web-abc",
      action_id: "source.import",
      skill_id: "mofa-notebook-source",
      status: "succeeded",
      input_path: "upload-handle-photo",
      filename: "photo.jpg",
      materialized_path: "uploads/photo.jpg",
      source_id: "photo",
      source_path: "notebook-sources/photo/source.md",
      created_at: "2026-07-09T01:00:00Z",
      updated_at: "2026-07-09T01:02:00Z",
    });

    expect(row.path).toBe("notebook-sources/photo/source.md");
    expect(row.sourceId).toBe("photo");
    expect(row.previewPath).toBe("uploads/photo.jpg");
    expect(sourcePreviewPath(row)).toBe("uploads/photo.jpg");
  });

  it("falls back to the row path when no original preview path exists", () => {
    expect(
      sourcePreviewPath({ filename: "notes.md", path: "research/notes.md", timestamp: 1 }),
    ).toBe("research/notes.md");
  });
});

describe("relativeTime", () => {
  const NOW = 1_750_000_000_000;

  it("returns 'just now' under a minute", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("just now");
  });

  it("returns minutes under an hour", () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5m ago");
  });

  it("returns hours under a day", () => {
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  });

  it("returns days under a week", () => {
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });

  it("falls back to a locale date beyond a week", () => {
    const old = NOW - 30 * 86_400_000;
    expect(relativeTime(old, NOW)).toBe(new Date(old).toLocaleDateString());
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(relativeTime(NOW + 60_000, NOW)).toBe("just now");
  });
});
