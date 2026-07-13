import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { downloadStudioFile } = vi.hoisted(() => ({
  downloadStudioFile: vi.fn().mockResolvedValue(undefined),
}));

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
vi.mock("./studio-file-download", () => ({ downloadStudioFile }));

import { StudioSourcePreview } from "./studio-source-preview";

describe("StudioSourcePreview", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    downloadStudioFile.mockClear();
    downloadStudioFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("moves focus into the preview when it replaces the Sources list", () => {
    render(
      <StudioSourcePreview
        row={{
          filename: "Report.pdf",
          path: "uploads/report.pdf",
          inputPath: "uploads/report.pdf",
          mediaType: "application/pdf",
          status: "processing",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back to sources" }),
    );
  });

  it("uses one tab stop and links the selected Source tab to its panel", () => {
    render(
      <StudioSourcePreview
        row={{
          sourceId: "report",
          filename: "Report.pdf",
          path: "notebook-sources/report/source.md",
          sourcePath: "notebook-sources/report/source.md",
          previewPath: "uploads/report.pdf",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    const original = screen.getByRole("tab", { name: "Original" });
    const parsed = screen.getByRole("tab", { name: "Parsed" });
    expect(original.tabIndex).toBe(0);
    expect(parsed.tabIndex).toBe(-1);
    expect(original.getAttribute("aria-controls")).toBe(screen.getByRole("tabpanel").id);

    fireEvent.click(parsed);
    expect(original.tabIndex).toBe(-1);
    expect(parsed.tabIndex).toBe(0);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(parsed.id);
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

  it("keeps a processing source on Original until parsed content exists", () => {
    render(
      <StudioSourcePreview
        row={{
          filename: "Processing.pdf",
          path: "uploads/processing.pdf",
          inputPath: "uploads/processing.pdf",
          previewPath: "uploads/processing.pdf",
          mediaType: "application/pdf",
          status: "processing",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Original" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByTestId("file-preview").getAttribute("data-path"))
      .toBe("uploads/processing.pdf");
    expect(screen.getByRole("button", { name: "Download original Processing.pdf" }))
      .toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Parsed" }));
    expect(screen.getByText("Parsed content is not available yet.")).toBeTruthy();
    expect(screen.queryByTestId("file-preview")).toBeNull();
  });

  it("does not infer parsed content from different transient input and preview paths", () => {
    render(
      <StudioSourcePreview
        row={{
          filename: "Processing.pdf",
          path: "uploads/processing.pdf",
          inputPath: "uploads/processing.pdf",
          materializedPath: "materialized/processing.pdf",
          previewPath: "materialized/processing.pdf",
          mediaType: "application/pdf",
          status: "processing",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Original" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByTestId("file-preview").getAttribute("data-path"))
      .toBe("materialized/processing.pdf");

    fireEvent.click(screen.getByRole("tab", { name: "Parsed" }));
    expect(screen.getByText("Parsed content is not available yet.")).toBeTruthy();
    expect(screen.queryByTestId("file-preview")).toBeNull();
  });

  it("does not offer a Parsed fallback for a failed Office source without parsed content", () => {
    render(
      <StudioSourcePreview
        row={{
          filename: "Failed.docx",
          path: "uploads/failed.docx",
          inputPath: "uploads/failed.docx",
          materializedPath: "materialized/failed.docx",
          previewPath: "materialized/failed.docx",
          status: "failed",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Original" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByText("The original file cannot be shown safely in the browser."))
      .toBeTruthy();
    expect(screen.queryByRole("button", { name: "View parsed content" })).toBeNull();
  });

  it("resets the selected tab and Source Guide when the source changes", () => {
    const view = render(
      <StudioSourcePreview
        row={{
          sourceId: "source-a",
          filename: "Source A.pdf",
          path: "notebook-sources/source-a/source.md",
          previewPath: "uploads/source-a.pdf",
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
          previewPath: "uploads/source-b.pdf",
          timestamp: 2,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Original" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByTestId("file-preview").getAttribute("data-path")).toBe(
      "uploads/source-b.pdf",
    );
  });

  it("uses a citation to choose Parsed initially but still lets the user switch tabs", () => {
    const view = render(
      <StudioSourcePreview
        row={{
          sourceId: "report",
          filename: "Report.pdf",
          path: "notebook-sources/report/source.md",
          sourcePath: "notebook-sources/report/source.md",
          previewPath: "uploads/report.pdf",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Original" }).getAttribute("aria-selected"))
      .toBe("true");

    view.rerender(
      <StudioSourcePreview
        row={{
          sourceId: "report",
          filename: "Report.pdf",
          path: "notebook-sources/report/source.md",
          sourcePath: "notebook-sources/report/source.md",
          previewPath: "uploads/report.pdf",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
        citationTarget={{ chunkId: "chunk-12", sourceId: "report", startLine: 12, endLine: 14 }}
      />,
    );

    expect(screen.getByRole("tab", { name: "Parsed" }).getAttribute("aria-selected"))
      .toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Original" }));

    expect(screen.getByRole("tab", { name: "Original" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByTestId("file-preview").getAttribute("data-path")).toBe(
      "uploads/report.pdf",
    );
  });

  it("does not treat parsed fallback content as the original file", () => {
    render(
      <StudioSourcePreview
        row={{
          sourceId: "missing-original",
          filename: "Statement.pdf",
          originalFilename: "Statement.pdf",
          path: "notebook-sources/missing-original/source.md",
          sourcePath: "notebook-sources/missing-original/source.md",
          previewPath: "notebook-sources/missing-original/source.md",
          inputPath: "uploads/missing-statement.pdf",
          mediaType: "application/pdf",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "Parsed" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.queryByRole("button", { name: /Download original/ })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Original" }));
    expect(screen.getByText("The original file is unavailable.")).toBeTruthy();
    expect(screen.queryByTestId("file-preview")).toBeNull();
  });

  it("downloads the original input path instead of the preview path", async () => {
    render(
      <StudioSourcePreview
        row={{
          sourceId: "report",
          filename: "Report.pdf",
          originalFilename: "Original report.pdf",
          path: "notebook-sources/report/source.md",
          sourcePath: "notebook-sources/report/source.md",
          previewPath: "previews/report.pdf",
          inputPath: "uploads/original-report.pdf",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download original Report.pdf" }));

    await waitFor(() => {
      expect(downloadStudioFile).toHaveBeenCalledWith(
        "uploads/original-report.pdf",
        "Original report.pdf",
        "web-abc",
      );
    });
  });

  it("downloads the materialized original instead of an opaque upload handle", async () => {
    render(
      <StudioSourcePreview
        row={{
          filename: "Report.pdf",
          path: "uploads/report.pdf",
          inputPath: "upload-handle-report",
          materializedPath: "uploads/report.pdf",
          previewPath: "uploads/report.pdf",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download original Report.pdf" }));

    await waitFor(() => {
      expect(downloadStudioFile).toHaveBeenCalledWith(
        "uploads/report.pdf",
        "Report.pdf",
        "web-abc",
      );
    });
  });

  it("keeps a newer tab selection when the original download fails", async () => {
    let rejectDownload: (reason?: unknown) => void = () => undefined;
    downloadStudioFile.mockReturnValueOnce(new Promise<void>((_resolve, reject) => {
      rejectDownload = reject;
    }));
    render(
      <StudioSourcePreview
        row={{
          sourceId: "report",
          filename: "Report.pdf",
          path: "notebook-sources/report/source.md",
          sourcePath: "notebook-sources/report/source.md",
          previewPath: "uploads/report.pdf",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download original Report.pdf" }));
    fireEvent.click(screen.getByRole("tab", { name: "Parsed" }));

    await act(async () => {
      rejectDownload(new Error("Download failed"));
    });

    expect((await screen.findByRole("alert")).textContent).toContain("Download failed");
    expect(screen.getByRole("tab", { name: "Parsed" }).getAttribute("aria-selected"))
      .toBe("true");
  });

  it("ignores an older download failure after a newer download succeeds", async () => {
    let rejectOlderDownload: (reason?: unknown) => void = () => undefined;
    downloadStudioFile
      .mockReturnValueOnce(new Promise<void>((_resolve, reject) => {
        rejectOlderDownload = reject;
      }))
      .mockResolvedValueOnce(undefined);
    render(
      <StudioSourcePreview
        row={{
          sourceId: "report",
          filename: "Report.pdf",
          path: "notebook-sources/report/source.md",
          sourcePath: "notebook-sources/report/source.md",
          previewPath: "uploads/report.pdf",
          timestamp: 1,
        }}
        sessionId="web-abc"
        onBack={vi.fn()}
      />,
    );

    const downloadButton = screen.getByRole("button", { name: "Download original Report.pdf" });
    fireEvent.click(downloadButton);
    fireEvent.click(downloadButton);
    await act(async () => undefined);

    await act(async () => {
      rejectOlderDownload(new Error("Old download failed"));
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
