import { cleanup, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { upsertSlidesProject } from "../store";
import { SlidesProvider } from "./slides-context";

const apiMocks = vi.hoisted(() => ({
  fetchSlidesManifest: vi.fn(),
  listSlidesFiles: vi.fn(),
}));
const profileMocks = vi.hoisted(() => ({
  getMyProfileStatus: vi.fn(),
}));

vi.mock("../api", () => apiMocks);
vi.mock("@/settings/settings-api", () => profileMocks);

describe("SlidesProvider runtime polling", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    apiMocks.fetchSlidesManifest.mockReset();
    apiMocks.listSlidesFiles.mockReset();
    apiMocks.listSlidesFiles.mockResolvedValue([]);
    profileMocks.getMyProfileStatus.mockReset();
  });

  it("does not poll slide files while the local runtime is stopped", async () => {
    profileMocks.getMyProfileStatus.mockResolvedValue({ running: false });
    upsertSlidesProject({
      id: "deck-1",
      title: "Household Brief",
      createdAt: 1,
      updatedAt: 1,
      scaffolded: true,
      slug: "household-brief",
      slides: [],
      template: "business",
      tags: [],
      versions: [],
    });

    render(
      <SlidesProvider projectId="deck-1">
        <div>slides child</div>
      </SlidesProvider>,
    );

    await waitFor(() => {
      expect(profileMocks.getMyProfileStatus).toHaveBeenCalled();
    });
    expect(apiMocks.listSlidesFiles).not.toHaveBeenCalled();
    expect(apiMocks.fetchSlidesManifest).not.toHaveBeenCalled();
  });
});
