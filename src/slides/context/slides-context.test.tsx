import { cleanup, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { upsertSlidesProject } from "../store";
import { SlidesProvider } from "./slides-context";

const apiMocks = vi.hoisted(() => ({
  fetchSlidesManifest: vi.fn(),
  fetchSlideEdits: vi.fn().mockResolvedValue(null),
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

  it("polls generated artifacts without requiring a standalone runtime", async () => {
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
      expect(apiMocks.listSlidesFiles).toHaveBeenCalledWith(
        ["slides/household-brief", "skill-output/slides/household-brief"], { sessionId: "deck-1" },
      );
      expect(apiMocks.fetchSlidesManifest).toHaveBeenCalledWith("household-brief", []);
    });
    expect(profileMocks.getMyProfileStatus).not.toHaveBeenCalled();
  });
});
