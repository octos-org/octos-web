import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { upsertSiteProject } from "../store";
import { SitesProvider } from "./sites-context";

const apiMocks = vi.hoisted(() => ({
  buildSitePreviewUrl: vi.fn(() => "/preview/site-1"),
  fetchSiteSession: vi.fn(),
  listSiteFiles: vi.fn(),
}));
const profileMocks = vi.hoisted(() => ({
  getMyProfileStatus: vi.fn(),
}));

vi.mock("../api", () => apiMocks);
vi.mock("@/settings/settings-api", () => profileMocks);
vi.mock("@/api/client", () => ({
  getSelectedProfileId: vi.fn(() => "admin"),
}));

describe("SitesProvider runtime polling", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    apiMocks.fetchSiteSession.mockReset();
    apiMocks.listSiteFiles.mockReset();
    apiMocks.listSiteFiles.mockResolvedValue([]);
    profileMocks.getMyProfileStatus.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not poll site files while the local runtime is stopped", async () => {
    profileMocks.getMyProfileStatus.mockResolvedValue({ running: false });
    upsertSiteProject({
      id: "site-1",
      title: "Family Hub",
      createdAt: 1,
      updatedAt: 1,
      profileId: "admin",
      preset: "learning",
      template: "quarto-lesson",
      siteKind: "course",
      slug: "family-hub",
      scaffolded: true,
    });

    render(
      <SitesProvider projectId="site-1">
        <div>site child</div>
      </SitesProvider>,
    );

    await waitFor(() => {
      expect(profileMocks.getMyProfileStatus).toHaveBeenCalled();
    });
    expect(apiMocks.listSiteFiles).not.toHaveBeenCalled();
    expect(apiMocks.fetchSiteSession).not.toHaveBeenCalled();
  });

  it("backs off runtime status polling while the local runtime remains stopped", async () => {
    vi.useFakeTimers();
    profileMocks.getMyProfileStatus.mockResolvedValue({ running: false });
    upsertSiteProject({
      id: "site-1",
      title: "Family Hub",
      createdAt: 1,
      updatedAt: 1,
      profileId: "admin",
      preset: "learning",
      template: "quarto-lesson",
      siteKind: "course",
      slug: "family-hub",
      scaffolded: true,
    });

    render(
      <SitesProvider projectId="site-1">
        <div>site child</div>
      </SitesProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(profileMocks.getMyProfileStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(profileMocks.getMyProfileStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(profileMocks.getMyProfileStatus).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(profileMocks.getMyProfileStatus).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(profileMocks.getMyProfileStatus).toHaveBeenCalledTimes(4);
    expect(apiMocks.listSiteFiles).not.toHaveBeenCalled();
  });
});
