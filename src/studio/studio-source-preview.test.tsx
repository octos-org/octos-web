import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({
  buildApiHeaders: () => ({ Authorization: "Bearer test-token" }),
}));
vi.mock("@/api/files", () => ({
  buildFileUrl: (path: string) => `/api/files/${encodeURIComponent(path)}`,
}));
vi.mock("./studio-file-preview", () => ({
  StudioFilePreview: ({ filename, filePath }: { filename: string; filePath: string }) => (
    <div data-testid="file-preview" data-path={filePath}>{filename}</div>
  ),
}));
vi.mock("./file-preview-mode", () => ({
  isFilePreviewable: (filename: string) => !filename.endsWith(".docx"),
}));

import { StudioSourcePreview } from "./studio-source-preview";

describe("StudioSourcePreview", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads Source Guide from metadata and preserves warnings and provenance", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        summary_path: "notebook-sources/report/summary.md",
      }),
    } as Response);

    render(
      <StudioSourcePreview
        row={{
          sourceId: "report",
          filename: "Q2 report.pdf",
          path: "notebook-sources/report/source.md",
          sourcePath: "notebook-sources/report/source.md",
          previewPath: "uploads/report.pdf",
          metadataPath: "notebook-sources/report/metadata.json",
          warnings: ["Page 4 could not be parsed."],
          provenance: { normalizer: "vertex", model: "gemini" },
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Source Guide" }));

    await waitFor(() => {
      expect(screen.getByTestId("file-preview").getAttribute("data-path")).toBe(
        "notebook-sources/report/summary.md",
      );
    });
    expect(screen.getByText("Page 4 could not be parsed.")).toBeTruthy();
    expect(screen.getByText(/vertex/)).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(
      "/api/files/notebook-sources%2Freport%2Fmetadata.json",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-token" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("opens an Office source on Parsed and lets Escape return to the list", () => {
    const onBack = vi.fn();
    render(
      <StudioSourcePreview
        row={{
          filename: "brief.docx",
          path: "notebook-sources/brief/source.md",
          sourcePath: "notebook-sources/brief/source.md",
          previewPath: "uploads/brief.docx",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={onBack}
      />,
    );

    expect(screen.getByRole("tab", { name: "Parsed" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByTestId("file-preview").getAttribute("data-path")).toBe(
      "notebook-sources/brief/source.md",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("resets the selected tab and Source Guide when the source changes", () => {
    const view = render(
      <StudioSourcePreview
        row={{
          sourceId: "source-a",
          filename: "Source A.pdf",
          path: "notebook-sources/source-a/source.md",
          summaryPath: "notebook-sources/source-a/summary.md",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Source Guide" }));
    expect(screen.getByTestId("file-preview").getAttribute("data-path")).toBe(
      "notebook-sources/source-a/summary.md",
    );

    view.rerender(
      <StudioSourcePreview
        row={{
          sourceId: "source-b",
          filename: "Source B.pdf",
          path: "notebook-sources/source-b/source.md",
          timestamp: 2,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Original" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByTestId("file-preview").getAttribute("data-path")).toBe(
      "notebook-sources/source-b/source.md",
    );
  });
});
