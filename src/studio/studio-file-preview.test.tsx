import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildApiHeadersMock = vi.hoisted(() =>
  vi.fn(() => ({ Authorization: "Bearer test-token" })),
);

vi.mock("@/api/client", () => ({ buildApiHeaders: buildApiHeadersMock }));
vi.mock("@/api/files", () => ({
  buildFileUrl: (path: string) => `/api/files/${encodeURIComponent(path)}`,
}));

import { isFilePreviewable } from "./file-preview-mode";
import { StudioFilePreview } from "./studio-file-preview";

describe("StudioFilePreview", () => {
  const fetchMock = vi.fn();
  const createObjectUrlMock = vi.fn(() => "blob:authenticated-preview");
  const revokeObjectUrlMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(["image"], { type: "image/jpeg" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrlMock,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrlMock,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("classifies Office files as normalized-content fallbacks", () => {
    expect(isFilePreviewable("brief.docx")).toBe(false);
    expect(isFilePreviewable("slides.pptx")).toBe(false);
    expect(isFilePreviewable("sheet.xlsx")).toBe(false);
    expect(isFilePreviewable("report.pdf", "application/pdf")).toBe(true);
    expect(isFilePreviewable("Renamed audio", "audio/ogg")).toBe(true);
    expect(isFilePreviewable("Renamed video", "video/quicktime")).toBe(true);
  });

  it("renders JSON as a structured tree", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "35" }),
      text: async () => JSON.stringify({ title: "Map", nodes: [{ id: 1 }] }),
    });
    render(
      <StudioFilePreview
        filename="map.json"
        filePath="ws/map.json"
        sessionId="web-abc"
        kind="asset"
      />,
    );

    expect(await screen.findByText('"Map"')).toBeTruthy();
    expect(screen.getByText("nodes")).toBeTruthy();
    expect(screen.queryByText(/\{"title"/)).toBeNull();
  });

  it("renders quoted CSV as a scrollable table", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "60" }),
      text: async () => 'name,notes\nAda,"line one, line two"\nLin,"multi\nline"',
    });
    render(
      <StudioFilePreview
        filename="people.csv"
        filePath="ws/people.csv"
        sessionId="web-abc"
        kind="asset"
      />,
    );

    expect(await screen.findByRole("table", { name: "people.csv" })).toBeTruthy();
    expect(screen.getByText("line one, line two")).toBeTruthy();
    expect(screen.getByText(/multi\s+line/)).toBeTruthy();
  });

  it("refuses an oversized text preview before reading its body", async () => {
    const text = vi.fn(async () => "too large");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(3 * 1024 * 1024) }),
      text,
    });
    render(
      <StudioFilePreview
        filename="large.json"
        filePath="ws/large.json"
        sessionId="web-abc"
        kind="asset"
      />,
    );

    expect(await screen.findByText(/too large to preview/i)).toBeTruthy();
    expect(text).not.toHaveBeenCalled();
  });

  it("refuses a declared oversized binary preview without fetching it", async () => {
    render(
      <StudioFilePreview
        filename="feature.mp4"
        filePath="notebook-outputs/video/feature.mp4"
        mediaType="video/mp4"
        size={51 * 1024 * 1024}
        sessionId="web-abc"
        kind="asset"
      />,
    );

    expect(await screen.findByText(/too large to preview/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an oversized binary response before reading its body", async () => {
    const blob = vi.fn(async () => new Blob(["too large"], { type: "video/mp4" }));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(51 * 1024 * 1024) }),
      blob,
    });
    render(
      <StudioFilePreview
        filename="feature.mp4"
        filePath="notebook-outputs/video/feature.mp4"
        mediaType="video/mp4"
        sessionId="web-abc"
        kind="asset"
      />,
    );

    expect(await screen.findByText(/too large to preview/i)).toBeTruthy();
    expect(blob).not.toHaveBeenCalled();
    expect(createObjectUrlMock).not.toHaveBeenCalled();
  });

  it("loads protected previews with auth headers and renders a blob URL", async () => {
    render(
      <StudioFilePreview
        filename="photo.jpg"
        filePath="uploads/photo.jpg"
        sessionId="web-abc"
        kind="source"
      />,
    );

    expect(
      (await screen.findByAltText("photo.jpg source preview")).getAttribute("src"),
    ).toBe("blob:authenticated-preview");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/uploads%2Fphoto.jpg",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(screen.queryByLabelText("Close source preview")).toBeNull();
    expect(document.querySelector(".fixed.inset-0")).toBeNull();
  });

  it("revokes the preview blob URL when unmounted", async () => {
    const view = render(
      <StudioFilePreview
        filename="photo.jpg"
        filePath="uploads/photo.jpg"
        sessionId="web-abc"
        kind="source"
      />,
    );
    await waitFor(() => expect(createObjectUrlMock).toHaveBeenCalled());

    view.unmount();

    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:authenticated-preview");
  });

  it("uses the source media type without sandboxing Chrome's PDF viewer", async () => {
    render(
      <StudioFilePreview
        filename="May statement"
        filePath="uploads/statement.pdf"
        mediaType="application/pdf"
        sessionId="web-abc"
        kind="source"
      />,
    );

    const frame = await screen.findByTitle("May statement source preview");
    expect(frame.getAttribute("src")).toBe("blob:authenticated-preview");
    expect(frame.getAttribute("sandbox")).toBeNull();
  });

  it("renders authenticated Markdown as document content instead of an iframe", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "# Quiz",
    });
    render(
      <StudioFilePreview
        filename="Quiz"
        filePath="ws/cXVpei5tZA/quiz.md"
        mediaType="text/markdown"
        sessionId="web-abc"
        kind="asset"
      />,
    );

    expect(await screen.findByRole("heading", { name: "Quiz" })).toBeTruthy();
    expect(screen.queryByTitle("Quiz asset preview")).toBeNull();
    expect(createObjectUrlMock).not.toHaveBeenCalled();
  });

  it("shows cited Markdown line context with the target range highlighted", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
    });
    render(
      <StudioFilePreview
        filename="source.md"
        filePath="notebook-sources/source/source.md"
        mediaType="text/markdown"
        sessionId="web-abc"
        kind="source"
        lineRange={{ start: 8, end: 9 }}
      />,
    );

    expect(await screen.findByText("8")).toBeTruthy();
    expect(screen.getByText("line 8").closest("div")?.getAttribute("data-cited-line")).toBe("true");
    expect(screen.getByText("line 9").closest("div")?.getAttribute("data-cited-line")).toBe("true");
    expect(screen.queryByText("line 1")).toBeNull();
    expect(screen.getByText("Showing lines 5–12")).toBeTruthy();
  });

  it("blocks active content even when its filename looks like a PDF", async () => {
    render(
      <StudioFilePreview
        filename="statement.pdf"
        filePath="uploads/statement.pdf"
        mediaType="text/html"
        sessionId="web-abc"
        kind="source"
      />,
    );

    expect(await screen.findByText("Preview unavailable for this file type."))
      .toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle("statement.pdf source preview")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open file" })).toBeNull();
  });

  it("rejects an active response MIME instead of creating a same-origin blob", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: async () => new Blob(["<script>alert(1)</script>"], { type: "text/html" }),
    });

    render(
      <StudioFilePreview
        filename="statement.pdf"
        filePath="uploads/statement.pdf"
        sessionId="web-abc"
        kind="source"
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Preview blocked because the file contains active content.",
    );
    expect(createObjectUrlMock).not.toHaveBeenCalled();
    expect(screen.queryByTitle("statement.pdf source preview")).toBeNull();
  });
});
