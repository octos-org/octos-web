import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectFiles } from "./project-files";

const apiMocks = vi.hoisted(() => ({
  fetchSlidesManifest: vi.fn(),
  fetchSlidesWorkspaceContract: vi.fn(),
  inferContentCategory: vi.fn(() => "report"),
  listSlidesFiles: vi.fn(),
  slidesFileToContentEntry: vi.fn((file) => ({ ...file, category: "report" })),
}));
const profileMocks = vi.hoisted(() => ({
  getMyProfileStatus: vi.fn(),
}));

vi.mock("../api", () => apiMocks);
vi.mock("@/settings/settings-api", () => profileMocks);
vi.mock("@/api/content", () => ({
  downloadContent: vi.fn(),
}));

describe("slides ProjectFiles", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  beforeEach(() => {
    cleanup();
    apiMocks.listSlidesFiles.mockReset();
    apiMocks.listSlidesFiles.mockResolvedValue([]);
    apiMocks.fetchSlidesManifest.mockReset();
    apiMocks.fetchSlidesManifest.mockResolvedValue(null);
    apiMocks.fetchSlidesWorkspaceContract.mockReset();
    apiMocks.fetchSlidesWorkspaceContract.mockResolvedValue(null);
    profileMocks.getMyProfileStatus.mockReset();
  });

  it("lists available files when the standalone gateway is stopped", async () => {
    profileMocks.getMyProfileStatus.mockResolvedValue({ running: false });
    apiMocks.listSlidesFiles.mockResolvedValue([{ filename: "script.js", path: "pf/opaque/script.js",
      group: "slides/deck", size: 10, modified: "2026-09-10T12:00:00Z" }]);
    render(<ProjectFiles slug="deck" sessionId="project-1" onOpenFile={vi.fn()} />);
    expect(await screen.findByText("script.js")).toBeTruthy();
    expect(screen.queryByText(/Local runtime is stopped/i)).toBeNull();
  });

  it("does not continue polling after an unmounted file request resolves", async () => {
    vi.useFakeTimers();
    let resolveFiles!: (value: []) => void;
    apiMocks.listSlidesFiles.mockReturnValue(new Promise<[]>((resolve) => { resolveFiles = resolve; }));
    const { unmount } = render(<ProjectFiles slug="deck" sessionId="project-1" onOpenFile={vi.fn()} />);
    expect(apiMocks.listSlidesFiles).toHaveBeenCalledOnce();
    unmount();
    await act(async () => { resolveFiles([]); await vi.advanceTimersByTimeAsync(5000); });
    expect(apiMocks.listSlidesFiles).toHaveBeenCalledOnce();
    expect(apiMocks.fetchSlidesManifest).not.toHaveBeenCalled();
  });
});
