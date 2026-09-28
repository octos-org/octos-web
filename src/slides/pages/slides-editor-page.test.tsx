import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import { getSlidesProject, upsertSlidesProject } from "../store";
import { SlidesEditorPage } from "./slides-editor-page";
import { SlidesPresentPage } from "./slides-present-page";

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

  it("hydrates backend files without requiring a standalone runtime", async () => {
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
    apiMocks.hydrateSlidesProjectFromSession.mockResolvedValue(project);

    render(
      <MemoryRouter initialEntries={["/slides/deck-1"]}>
        <Routes>
          <Route path="/slides/:id" element={<SlidesEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("editor layout")).toBeTruthy();
    await waitFor(() => {
      expect(apiMocks.hydrateSlidesProjectFromSession).toHaveBeenCalledWith("deck-1");
    });
    expect(profileMocks.getMyProfileStatus).not.toHaveBeenCalled();
  });

  it("does not rehydrate an incomplete scaffold on unrelated renders", async () => {
    const project = { id: "deck-loop", title: "Incomplete deck", createdAt: 1, updatedAt: 1,
      scaffolded: true, slug: "deck-loop", slides: [], template: "business", tags: [], versions: [] };
    upsertSlidesProject(project);
    contextMocks.currentProject = project;
    let resolveHydration!: (value: typeof project) => void;
    apiMocks.hydrateSlidesProjectFromSession
      .mockReturnValueOnce(new Promise(resolve => { resolveHydration = resolve; }))
      .mockReturnValue(new Promise(() => {}));
    const tree = <MemoryRouter initialEntries={["/slides/deck-loop"]}><Routes>
      <Route path="/slides/:id" element={<SlidesEditorPage />} />
    </Routes></MemoryRouter>;
    const view = render(tree);
    await act(async () => { resolveHydration(project); });
    view.rerender(<MemoryRouter initialEntries={["/slides/deck-loop"]}><Routes>
      <Route path="/slides/:id" element={<SlidesEditorPage />} />
    </Routes></MemoryRouter>);
    expect(apiMocks.hydrateSlidesProjectFromSession).toHaveBeenCalledTimes(1);
  });

  for (const [route, Page] of [["/slides/:id", SlidesEditorPage], ["/slides/:id/present", SlidesPresentPage]] as const) {
    it(`restores a fresh direct link at ${route}`, async () => {
      const project = { id: "fresh-deck", title: "Fresh deck", createdAt: 1, updatedAt: 1,
        scaffolded: true, slug: "fresh-deck", slides: [], template: "business", tags: [], versions: [] };
      contextMocks.currentProject = project;
      profileMocks.getMyProfileStatus.mockResolvedValue({ running: false });
      apiMocks.hydrateSlidesProjectFromSession.mockResolvedValue(project);
      render(<MemoryRouter initialEntries={[route.replace(":id", "fresh-deck")]}><Routes>
        <Route path={route} element={<Page />} />
      </Routes></MemoryRouter>);
      await waitFor(() => expect(getSlidesProject("fresh-deck")?.title).toBe("Fresh deck"));
      expect(screen.queryByText("Slides session unavailable")).toBeNull();
      expect(profileMocks.getMyProfileStatus).not.toHaveBeenCalled();
    });

    it(`shows the actual hydration error at ${route}`, async () => {
      apiMocks.hydrateSlidesProjectFromSession.mockRejectedValue(new Error("Workspace access denied"));
      render(<MemoryRouter initialEntries={[route.replace(":id", "missing-deck")]}><Routes>
        <Route path={route} element={<Page />} />
      </Routes></MemoryRouter>);
      expect(await screen.findByText("Workspace access denied")).toBeTruthy();
    });
  }
});
