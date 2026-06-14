import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectFiles } from "./project-files";

const apiMocks = vi.hoisted(() => ({
  listSiteFiles: vi.fn(),
  siteFileToContentEntry: vi.fn(),
  inferContentCategory: vi.fn(() => "report"),
  uploadSiteFiles: vi.fn(),
}));
const profileMocks = vi.hoisted(() => ({
  getMyProfileStatus: vi.fn(),
}));

vi.mock("../api", () => apiMocks);
vi.mock("@/settings/settings-api", () => profileMocks);
vi.mock("@/api/content", () => ({
  downloadContent: vi.fn(),
}));

describe("site ProjectFiles", () => {
  beforeEach(() => {
    cleanup();
    apiMocks.listSiteFiles.mockReset();
    apiMocks.listSiteFiles.mockResolvedValue([]);
    profileMocks.getMyProfileStatus.mockReset();
  });

  it("does not request project files while the local runtime is stopped", async () => {
    profileMocks.getMyProfileStatus.mockResolvedValue({ running: false });

    render(
      <ProjectFiles
        slug="family-hub"
        sessionId="site-1"
        onOpenFile={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/Local runtime is stopped/i),
    ).toBeTruthy();
    await waitFor(() => {
      expect(apiMocks.listSiteFiles).not.toHaveBeenCalled();
    });
  });

  it("does not request project files after unmount while runtime status is resolving", async () => {
    let resolveStatus!: (value: { running: boolean }) => void;
    const statusPromise = new Promise<{ running: boolean }>((resolve) => {
      resolveStatus = resolve;
    });
    profileMocks.getMyProfileStatus.mockReturnValue(statusPromise);

    const { unmount } = render(
      <ProjectFiles
        slug="family-hub"
        sessionId="site-1"
        onOpenFile={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(profileMocks.getMyProfileStatus).toHaveBeenCalled();
    });
    unmount();
    await act(async () => {
      resolveStatus({ running: false });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.listSiteFiles).not.toHaveBeenCalled();
  });
});
