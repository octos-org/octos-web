import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildApiHeadersMock = vi.hoisted(() =>
  vi.fn(() => ({ Authorization: "Bearer test-token" })),
);

vi.mock("@/api/client", () => ({ buildApiHeaders: buildApiHeadersMock }));
vi.mock("@/api/files", () => ({
  buildFileUrl: (path: string) => `/api/files/${encodeURIComponent(path)}`,
}));

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

  it("uses the source media type when a renamed PDF has no extension", async () => {
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
    expect(frame.getAttribute("sandbox")).toBe("");
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
