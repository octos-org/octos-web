import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import { upsertSlidesProject } from "../store";
import { SlidesEditorPage } from "./slides-editor-page";

const apiMocks = vi.hoisted(() => ({
  hydrateSlidesProjectFromSession: vi.fn(),
}));
const contextMocks = vi.hoisted(() => ({
  currentProject: undefined as unknown,
  save: vi.fn(),
}));
const profileMocks = vi.hoisted(() => ({
  getMyProfileStatus: vi.fn(),
}));

vi.mock("../api", () => apiMocks);
vi.mock("@/settings/settings-api", () => profileMocks);
vi.mock("../context/slides-context", () => ({
  SlidesProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSlides: () => ({
    project: contextMocks.currentProject,
    save: contextMocks.save,
  }),
}));
vi.mock("../layouts/slides-editor-layout", () => ({
  SlidesEditorLayout: () => <div>editor layout</div>,
}));
vi.mock("../components/slide-preview", () => ({
  default: () => <div>slide preview</div>,
}));
vi.mock("../components/slides-chat", () => ({
  SlidesChat: () => <div>slides chat</div>,
}));

describe("SlidesEditorPage hydration", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    apiMocks.hydrateSlidesProjectFromSession.mockReset();
    profileMocks.getMyProfileStatus.mockReset();
    contextMocks.save.mockReset();
    contextMocks.currentProject = undefined;
  });

  it("does not hydrate from backend files while the local runtime is stopped", async () => {
    const project = {
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
    };
    contextMocks.currentProject = project;
    profileMocks.getMyProfileStatus.mockResolvedValue({ running: false });
    upsertSlidesProject(project);

    render(
      <MemoryRouter initialEntries={["/slides/deck-1"]}>
        <Routes>
          <Route path="/slides/:id" element={<SlidesEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("editor layout")).toBeTruthy();
    await waitFor(() => {
      expect(profileMocks.getMyProfileStatus).toHaveBeenCalled();
    });
    expect(apiMocks.hydrateSlidesProjectFromSession).not.toHaveBeenCalled();
  });
});
