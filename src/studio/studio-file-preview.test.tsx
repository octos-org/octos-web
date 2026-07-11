import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildApiHeadersMock = vi.hoisted(() =>
  vi.fn(() => ({ Authorization: "Bearer test-token" })),
);

vi.mock("@/api/client", () => ({ buildApiHeaders: buildApiHeadersMock }));
vi.mock("@/api/files", () => ({
  buildFileUrl: (path: string) => `/api/files/${encodeURIComponent(path)}`,
}));

import { StudioFilePreviewDialog } from "./studio-file-preview";

describe("StudioFilePreviewDialog", () => {
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
      <StudioFilePreviewDialog
        filename="photo.jpg"
        filePath="uploads/photo.jpg"
        sessionId="web-abc"
        kind="source"
        onClose={() => {}}
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
  });

  it("revokes the preview blob URL when unmounted", async () => {
    const view = render(
      <StudioFilePreviewDialog
        filename="photo.jpg"
        filePath="uploads/photo.jpg"
        sessionId="web-abc"
        kind="source"
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(createObjectUrlMock).toHaveBeenCalled());

    view.unmount();

    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:authenticated-preview");
  });
});
