import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Mocks — heavy runtime deps are stubbed; `@/runtime/session-context` stays
// REAL so the hand-built SessionContextValue is type-checked against the
// canonical interface.
// ---------------------------------------------------------------------------

const sendMessageMock = vi.hoisted(() => vi.fn());
const threadStoreMocks = vi.hoisted(() => ({
  loadHistory: vi.fn(),
}));
const uploadFilesMock = vi.hoisted(() =>
  vi.fn(async () => ["research/up.pdf"]),
);
const invokeSkillActionMock = vi.hoisted(() =>
  vi.fn(async () => ({
    action_id: "source.import",
    ok: true,
    materialized_paths: ["uploads/up.pdf"],
    results: [{ success: true, output: "captured" }],
  })),
);
const listSkillActionJobsMock = vi.hoisted(() => vi.fn(async () => []));
const loadSourceCatalogMock = vi.hoisted(() => vi.fn(async () => []));
const listSkillActionsMock = vi.hoisted(() =>
  vi.fn(async () =>
    [
      ["video_overview.generate", "Video Overview"],
      ["mindmap.generate", "Mind Map"],
      ["reports.generate", "Reports"],
      ["flashcards.generate", "Flashcards"],
      ["quiz.generate", "Quiz"],
      ["data_table.generate", "Data Table"],
    ].map(([id, label]) => ({
      id,
      skill_id: "test-skill",
      label,
      tags: ["notebook"],
      surfaces: ["studio.skills"],
      input_schema: {},
      execution: "background",
      available: true,
    })),
  ),
);
const fileFixtures = vi.hoisted(() => [
  {
    id: "f1",
    sessionId: "web-abc",
    filename: "notes.md",
    filePath: "research/notes.md",
    status: "ready" as const,
    timestamp: 2000,
  },
  {
    id: "f2",
    sessionId: "web-abc",
    filename: "chart.png",
    filePath: "research/chart.png",
    status: "generating" as const,
    timestamp: 1000,
    toolName: "data_viz",
  },
  {
    id: "f3",
    sessionId: "web-other",
    filename: "other.md",
    filePath: "research/other.md",
    status: "ready" as const,
    timestamp: 3000,
  },
]);
const loadSessionFilesMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/components/chat-thread", () => ({
  ChatThread: (props: { allowAttachments?: boolean }) => (
    <div
      data-testid="chat-thread-stub"
      data-allow-attachments={String(props.allowAttachments)}
    />
  ),
}));
vi.mock("@/components/ui-protocol-approval-host", () => ({
  UiProtocolApprovalHost: () => null,
}));
vi.mock("@/components/studio-nav", () => ({
  StudioNav: ({ actions }: { actions?: ReactNode }) => (
    <nav data-testid="studio-nav">{actions}</nav>
  ),
}));
vi.mock("@/runtime/runtime-provider", () => ({
  ScopedRuntimeBridge: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/runtime/ui-protocol-send", () => ({
  sendMessage: sendMessageMock,
}));
vi.mock("@/store/thread-store", () => threadStoreMocks);
vi.mock("@/store/file-store", () => ({
  useAllFiles: () => fileFixtures,
  loadSessionFiles: loadSessionFilesMock,
}));
vi.mock("@/api/chat", () => ({
  uploadFiles: uploadFilesMock,
}));
vi.mock("@/api/skill-actions", () => ({
  invokeSkillAction: invokeSkillActionMock,
  listSkillActions: listSkillActionsMock,
  listSkillActionJobs: listSkillActionJobsMock,
}));
vi.mock("./source-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./source-store")>();
  return { ...actual, loadSourceCatalog: loadSourceCatalogMock };
});

import { STUDIO_SKILLS } from "./skills";
import { StudioPage } from "./studio-page";

function readySourceJob(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "job-photo",
    batch_id: "batch-photo",
    profile_id: "alan0x",
    session_id: "web-abc",
    action_id: "source.import",
    skill_id: "mofa-notebook-source",
    status: "succeeded",
    input_path: "upload-handle-photo",
    filename: "photo.jpg",
    materialized_path: "uploads/photo.jpg",
    source_id: "photo",
    source_path: "notebook-sources/photo/source.md",
    metadata_path: "notebook-sources/photo/metadata.json",
    created_at: "2026-07-09T01:00:00Z",
    updated_at: "2026-07-09T01:02:00Z",
    ...overrides,
  };
}

function readyVideoOverviewJob() {
  return {
    job_id: "job-video",
    batch_id: "batch-video",
    profile_id: "alan0x",
    session_id: "web-abc",
    action_id: "video_overview.generate",
    skill_id: "mofa-notebook-video",
    status: "succeeded",
    result: {
      title: "Market overview",
      artifacts: [
        ["overview.mp4", "video/mp4"],
        ["script.md", "text/markdown"],
        ["scene-plan.json", "application/json"],
        ["asset-brief.md", "text/markdown"],
        ["handoff.md", "text/markdown"],
        ["veo-prompt.txt", "text/plain"],
        ["veo-operation.json", "application/json"],
      ].map(([display_name, media_type]) => ({
        handle: `ws/video/${display_name}`,
        display_name,
        media_type,
        size: 42,
      })),
    },
    created_at: "2026-07-09T01:00:00Z",
    updated_at: "2026-07-09T01:01:00Z",
  };
}

function mockSourceImportJobs(jobs: unknown[] = [readySourceJob()]) {
  listSkillActionJobsMock.mockImplementation(
    (_sessionId: string, options?: { actionId?: string }) =>
      Promise.resolve(options?.actionId === "source.import" ? jobs : []),
  );
  loadSourceCatalogMock.mockResolvedValue(
    (jobs as ReturnType<typeof readySourceJob>[])
      .filter((job) => job.status === "succeeded" && job.source_id)
      .map((job) => ({
        sourceId: job.source_id,
        filename: job.filename,
        path: job.source_path,
        sourcePath: job.source_path,
        inputPath: job.materialized_path,
        previewPath: job.materialized_path,
        timestamp: Date.parse(job.updated_at),
        status: "ready",
      })),
  );
}

function renderStudio(path = "/studio/web-abc") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/studio/:projectId" element={<StudioPage />} />
        <Route path="/" element={<div data-testid="home-stub" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  localStorage.clear();
  // Pane defaults follow window width (jsdom is 1024px, so the rail
  // would start closed); pin both open so every pane is testable.
  localStorage.setItem(
    "octos-studio-panes",
    JSON.stringify({ sources: true, rail: true }),
  );
  sendMessageMock.mockReset();
  threadStoreMocks.loadHistory.mockReset();
  loadSessionFilesMock.mockClear();
  uploadFilesMock.mockClear();
  uploadFilesMock.mockResolvedValue(["research/up.pdf"]);
  invokeSkillActionMock.mockClear();
  listSkillActionJobsMock.mockClear();
  listSkillActionJobsMock.mockResolvedValue([]);
  loadSourceCatalogMock.mockReset();
  loadSourceCatalogMock.mockResolvedValue([
    {
      sourceId: "notes",
      filename: "notes.md",
      path: "notebook-sources/notes/source.md",
      sourcePath: "notebook-sources/notes/source.md",
      inputPath: "research/notes.md",
      previewPath: "research/notes.md",
      timestamp: 2000,
      status: "ready",
    },
  ]);
  invokeSkillActionMock.mockResolvedValue({
    action_id: "source.import",
    ok: true,
    materialized_paths: ["uploads/up.pdf"],
    results: [{ success: true, output: "captured" }],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["preview"]),
      text: async () => "# Quiz",
    })),
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:studio-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("StudioPage", () => {
  it("renders the 3-pane workspace with the pinned chat and catalog sources", async () => {
    localStorage.setItem(
      "octos_session_titles",
      JSON.stringify({ "web-abc": "My Research" }),
    );
    renderStudio();

    expect(screen.getByTestId("studio-page")).toBeTruthy();
    expect(screen.getByTestId("chat-thread-stub")).toBeTruthy();
    expect(
      screen
        .getByTestId("chat-thread-stub")
        .getAttribute("data-allow-attachments"),
    ).toBe("false");
    expect(screen.getByTestId("studio-sources-pane")).toBeTruthy();
    expect(screen.getByTestId("studio-rail")).toBeTruthy();
    expect(screen.getByTestId("studio-title").textContent).toBe("My Research");

    // Ready rows come from the authoritative source catalog.
    const sourcesPane = within(screen.getByTestId("studio-sources-pane"));
    expect(await sourcesPane.findByText("notes.md")).toBeTruthy();
    expect(sourcesPane.queryByText("chart.png")).toBeNull();
    expect(sourcesPane.queryByText("other.md")).toBeNull();

    expect(loadSourceCatalogMock).toHaveBeenCalledWith("web-abc");
    expect(threadStoreMocks.loadHistory).toHaveBeenCalledWith(
      "web-abc",
      undefined,
    );
  });

  it("resizes the Sources pane and persists its width", async () => {
    localStorage.setItem("octos_studio_sources_width", "360");
    renderStudio();

    const pane = screen.getByTestId("studio-sources-pane");
    const handle = screen.getByTestId("studio-sources-resize-handle");
    expect(pane.style.width).toBe("360px");
    expect(handle.className).toContain("max-lg:hidden");

    fireEvent(
      handle,
      new MouseEvent("pointerdown", { bubbles: true, clientX: 360 }),
    );
    fireEvent(
      document,
      new MouseEvent("pointermove", { bubbles: true, clientX: 440 }),
    );
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true }));

    expect(pane.style.width).toBe("440px");
    await waitFor(() => {
      expect(localStorage.getItem("octos_studio_sources_width")).toBe("440");
    });
  });

  it("resizes the Studio rail, clamps its width, and persists it", async () => {
    localStorage.setItem("octos_studio_rail_width", "400");
    renderStudio();

    const rail = screen.getByTestId("studio-rail");
    const handle = screen.getByTestId("studio-rail-resize-handle");
    expect(rail.style.width).toBe("400px");
    expect(handle.className).toContain("max-xl:hidden");

    fireEvent(
      handle,
      new MouseEvent("pointerdown", { bubbles: true, clientX: 900 }),
    );
    fireEvent(
      document,
      new MouseEvent("pointermove", { bubbles: true, clientX: 0 }),
    );
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true }));

    expect(rail.style.width).toBe("520px");
    await waitFor(() => {
      expect(localStorage.getItem("octos_studio_rail_width")).toBe("520");
    });
  });

  it("resizes the Sources pane with Pointer Events and exposes separator metadata", async () => {
    localStorage.setItem("octos_studio_sources_width", "360");
    renderStudio();

    const pane = screen.getByTestId("studio-sources-pane");
    const handle = screen.getByRole("separator", { name: "Resize Sources pane" });
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-valuemin")).toBe("240");
    expect(handle.getAttribute("aria-valuemax")).toBe("480");
    expect(handle.getAttribute("aria-valuenow")).toBe("360");

    // jsdom does not implement PointerEvent, so dispatch pointer-named mouse
    // events to preserve the real client coordinates used by the handler.
    fireEvent(
      handle,
      new MouseEvent("pointerdown", { bubbles: true, clientX: 360 }),
    );
    fireEvent(
      document,
      new MouseEvent("pointermove", { bubbles: true, clientX: 420 }),
    );
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true }));

    expect(pane.style.width).toBe("420px");
    await waitFor(() => {
      expect(localStorage.getItem("octos_studio_sources_width")).toBe("420");
    });
  });

  it("resizes the Studio rail from the keyboard using physical separator direction", () => {
    localStorage.setItem("octos_studio_rail_width", "400");
    renderStudio();

    const rail = screen.getByTestId("studio-rail");
    const handle = screen.getByRole("separator", { name: "Resize Studio pane" });

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(rail.style.width).toBe("416px");
    expect(handle.getAttribute("aria-valuenow")).toBe("416");

    fireEvent.keyDown(handle, { key: "End" });
    expect(rail.style.width).toBe("520px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(rail.style.width).toBe("280px");
  });

  it("falls back to the default title when none is stored", () => {
    renderStudio();
    expect(screen.getByTestId("studio-title").textContent).toBe(
      "Studio Project",
    );
  });

  it("redirects legacy non web- project ids home", () => {
    renderStudio("/studio/studio-legacy");
    expect(screen.getByTestId("home-stub")).toBeTruthy();
    expect(screen.queryByTestId("studio-page")).toBeNull();
  });

  it("updates the grounding footer when a catalog source is checked", async () => {
    renderStudio();

    expect(screen.queryByText(/source/, { selector: "p" })).toBeNull();
    fireEvent.click(await screen.findByLabelText("Use notes.md as source"));
    expect(
      screen.getByText(/1 source selected for notebook grounding/),
    ).toBeTruthy();

    // Unchecking drops it back down.
    fireEvent.click(screen.getByLabelText("Use notes.md as source"));
    expect(screen.queryByText(/source selected for notebook grounding/)).toBeNull();
  });

  it("does not treat unclassified session files as sources", async () => {
    loadSourceCatalogMock.mockResolvedValue([]);
    renderStudio();

    const sourcesPane = within(screen.getByTestId("studio-sources-pane"));
    await waitFor(() => {
      expect(sourcesPane.queryByText("notes.md")).toBeNull();
    });
    expect(sourcesPane.queryByText("chart.png")).toBeNull();
  });

  it("renders notebook-style studio skills from the installed notebook skill set", () => {
    renderStudio();

    expect(STUDIO_SKILLS.map((skill) => skill.label)).toEqual([
      "Audio Overview",
      "Slide Deck",
      "Video Overview",
      "Mind Map",
      "Reports",
      "Flashcards",
      "Quiz",
      "Infographic",
      "Data Table",
    ]);

    const studioRail = within(screen.getByTestId("studio-rail"));
    for (const skill of STUDIO_SKILLS) {
      expect(
        studioRail.getByRole("button", { name: new RegExp(skill.label) }),
      ).toBeTruthy();
    }
  });

  it("invokes a notebook skill action with selected imported source ids", async () => {
    mockSourceImportJobs();
    invokeSkillActionMock.mockResolvedValueOnce({
      action_id: "quiz.generate",
      ok: true,
      execution: "background",
      queued: 1,
      batch_id: "batch-quiz",
      jobs: [
        {
          job_id: "job-quiz",
          batch_id: "batch-quiz",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "quiz.generate",
          skill_id: "mofa-notebook-study",
          status: "running",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:00:00Z",
        },
      ],
    });

    renderStudio();
    await screen.findByText("photo.jpg");
    fireEvent.click(screen.getByLabelText("Use photo.jpg as source"));

    fireEvent.click(screen.getByRole("button", { name: "Quiz" }));

    await waitFor(() => {
      expect(invokeSkillActionMock).toHaveBeenCalledWith(
        "web-abc",
        "quiz.generate",
        { source_ids: ["photo"] },
      );
    });
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId("studio-rail")).getByText("Generating"),
    ).toBeTruthy();
  });

  it("previews and downloads a completed studio action as one logical asset", async () => {
    mockSourceImportJobs();
    invokeSkillActionMock.mockResolvedValueOnce({
      action_id: "quiz.generate",
      ok: true,
      execution: "background",
      queued: 1,
      batch_id: "batch-quiz",
      jobs: [
        {
          job_id: "job-quiz",
          batch_id: "batch-quiz",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "quiz.generate",
          skill_id: "mofa-notebook-study",
          status: "running",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:00:00Z",
        },
      ],
    });

    renderStudio();
    await screen.findByText("photo.jpg");
    fireEvent.click(screen.getByLabelText("Use photo.jpg as source"));
    fireEvent.click(screen.getByRole("button", { name: "Quiz" }));

    fireEvent(
      window,
      new CustomEvent("crew:skill_action_job_updated", {
        detail: {
          job_id: "job-quiz",
          batch_id: "batch-quiz",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "quiz.generate",
          skill_id: "mofa-notebook-study",
          status: "succeeded",
          result: {
            artifacts: [
              {
                handle: "ws/bm90ZWJvb2stb3V0cHV0cy9xdWl6Lm1k/quiz.md",
                display_name: "quiz.md",
                media_type: "text/markdown",
                size: 42,
              },
            ],
          },
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:01:00Z",
        },
      }),
    );

    const rail = screen.getByTestId("studio-rail");
    expect(await within(rail).findByRole("button", { name: "Open Quiz" })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: "Download Quiz" })).toBeTruthy();

    const openQuiz = within(rail).getByRole("button", { name: "Open Quiz" });
    fireEvent.click(openQuiz);
    expect(await within(rail).findByRole("button", { name: "Back to Studio" }))
      .toBeTruthy();
    expect(await within(rail).findByRole("heading", { name: "Quiz" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("chat-thread-stub")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(rail).getByRole("button", { name: "Open Quiz" }),
      );
    });

    const appendChild = vi.spyOn(document.body, "appendChild");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(within(rail).getByRole("button", { name: "Download Quiz" }));
    await waitFor(() => expect(appendChild).toHaveBeenCalled());
    expect((appendChild.mock.calls[0][0] as HTMLAnchorElement).download).toBe("quiz.md");
  });

  it("groups a multi-file Video Overview into one Studio asset viewer", async () => {
    listSkillActionJobsMock.mockImplementation(
      (_sessionId: string, options?: { actionId?: string }) =>
        Promise.resolve(options?.actionId === "source.import" ? [] : [readyVideoOverviewJob()]),
    );

    renderStudio();

    const rail = screen.getByTestId("studio-rail");
    const open = await within(rail).findByRole("button", {
      name: "Open Market overview",
    });
    expect(within(rail).queryByText("script.md")).toBeNull();
    expect(within(rail).queryByText("scene-plan.json")).toBeNull();

    fireEvent.click(open);
    expect(within(rail).getByRole("button", { name: "Back to Studio" })).toBeTruthy();
    for (const tab of ["Overview", "Script", "Scenes", "Assets", "Files"]) {
      expect(within(rail).getByRole("tab", { name: tab })).toBeTruthy();
    }
    expect(screen.getByTestId("chat-thread-stub")).toBeTruthy();

    fireEvent.click(within(rail).getByRole("tab", { name: "Files" }));
    expect(within(rail).getAllByRole("button", { name: /^Download / }))
      .toHaveLength(7);

    fireEvent.click(screen.getByRole("button", { name: "Toggle studio rail" }));
    expect(screen.queryByTestId("studio-rail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle studio rail" }));
    expect(
      await within(screen.getByTestId("studio-rail")).findByRole("button", {
        name: "Back to Studio",
      }),
    ).toBeTruthy();
  });

  it("closes the Studio drawer when a citation opens Sources on a narrow screen", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500,
    });
    const mindMapJob = {
      job_id: "job-map",
      batch_id: "batch-map",
      profile_id: "alan0x",
      session_id: "web-abc",
      action_id: "mindmap.generate",
      skill_id: "mofa-notebook-map",
      status: "succeeded" as const,
      result: {
        title: "Research map",
        artifacts: [{
          handle: "ws/map/map.json",
          display_name: "map.json",
          media_type: "application/json",
          size: 42,
        }],
      },
      created_at: "2026-07-09T01:00:00Z",
      updated_at: "2026-07-09T01:01:00Z",
    };
    listSkillActionJobsMock.mockImplementation(
      (_sessionId: string, options?: { actionId?: string }) =>
        Promise.resolve(options?.actionId === "source.import" ? [] : [mindMapJob]),
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        title: "Research map",
        root: "Root",
        nodes: [{
          id: "root",
          label: "Root",
          summary: "Summary",
          citations: [{ chunk_id: "chunk-1", source_id: "notes" }],
        }],
      }),
    } as Response);

    renderStudio();
    const rail = screen.getByTestId("studio-rail");
    fireEvent.click(await within(rail).findByRole("button", {
      name: "Open Research map",
    }));
    fireEvent.click(await within(rail).findByRole("button", {
      name: "Open node Root",
    }));
    fireEvent.click(within(rail).getByRole("button", { name: "Open cited source" }));

    expect(screen.queryByTestId("studio-rail")).toBeNull();
    expect(
      within(screen.getByTestId("studio-sources-pane")).getByRole("button", {
        name: "Back to sources",
      }),
    ).toBeTruthy();
  });

  it("does not show a stale download failure in a different asset preview", async () => {
    const secondAsset = {
      job_id: "job-second-quiz",
      batch_id: "batch-second-quiz",
      profile_id: "alan0x",
      session_id: "web-abc",
      action_id: "quiz.generate",
      skill_id: "mofa-notebook-study",
      status: "succeeded" as const,
      result: {
        title: "Second quiz",
        artifacts: [{
          handle: "ws/second-quiz.md",
          display_name: "second-quiz.md",
          media_type: "text/markdown",
          size: 42,
        }],
      },
      created_at: "2026-07-09T01:00:00Z",
      updated_at: "2026-07-09T01:01:00Z",
    };
    listSkillActionJobsMock.mockImplementation(
      (_sessionId: string, options?: { actionId?: string }) =>
        Promise.resolve(options?.actionId === "source.import"
          ? []
          : [readyVideoOverviewJob(), secondAsset]),
    );
    let resolveDownload: (response: Response) => void = () => undefined;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveDownload = resolve;
    }));

    renderStudio();
    const rail = screen.getByTestId("studio-rail");
    fireEvent.click(await within(rail).findByRole("button", {
      name: "Download Market overview",
    }));
    fireEvent.click(within(rail).getByRole("button", { name: "Open Second quiz" }));

    await act(async () => {
      resolveDownload({ ok: false, status: 500 } as Response);
    });

    expect(within(rail).queryByRole("alert")).toBeNull();
  });

  it("restores persisted generated assets after a page refresh", async () => {
    listSkillActionJobsMock.mockImplementation(
      (_sessionId: string, options?: { actionId?: string }) =>
        Promise.resolve(
          options?.actionId === "source.import"
            ? []
            : [
                {
                  job_id: "job-restored-quiz",
                  batch_id: "batch-restored-quiz",
                  profile_id: "alan0x",
                  session_id: "web-abc",
                  action_id: "quiz.generate",
                  skill_id: "mofa-notebook-study",
                  status: "succeeded",
                  result: {
                    title: "Restored quiz",
                    artifacts: [
                      {
                        handle: "ws/cmVzdG9yZWQtcXVpei5tZA/restored-quiz.md",
                        display_name: "restored-quiz.md",
                        media_type: "text/markdown",
                        size: 42,
                      },
                    ],
                  },
                  created_at: "2026-07-09T01:00:00Z",
                  updated_at: "2026-07-09T01:01:00Z",
                },
              ],
        ),
    );

    renderStudio();

    const rail = screen.getByTestId("studio-rail");
    expect(await within(rail).findByRole("button", { name: "Open Restored quiz" }))
      .toBeTruthy();
    expect(within(rail).getByRole("button", { name: "Download Restored quiz" }))
      .toBeTruthy();
  });

  it("disables source-required action skills until a source is selected", () => {
    renderStudio();

    const dataTable = screen.getByRole("button", {
      name: "Data Table",
    }) as HTMLButtonElement;
    expect(dataTable.disabled).toBe(true);

    fireEvent.click(dataTable);
    expect(invokeSkillActionMock).not.toHaveBeenCalled();
  });

  it("does not send selected notebook sources as chat turn media attachments", async () => {
    mockSourceImportJobs();
    invokeSkillActionMock.mockResolvedValueOnce({
      action_id: "mindmap.generate",
      ok: true,
      execution: "background",
      queued: 0,
      jobs: [],
    });
    renderStudio();
    await screen.findByText("photo.jpg");
    fireEvent.click(screen.getByLabelText("Use photo.jpg as source"));

    fireEvent.click(screen.getByRole("button", { name: "Mind Map" }));

    await waitFor(() =>
      expect(invokeSkillActionMock).toHaveBeenCalledWith(
        "web-abc",
        "mindmap.generate",
        { source_ids: ["photo"] },
      ),
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("uploads sources and shows the queued import without auto-selecting it", async () => {
    invokeSkillActionMock.mockResolvedValueOnce({
      action_id: "source.import",
      ok: true,
      queued: 1,
      jobs: [
        {
          job_id: "job-up",
          batch_id: "batch-up",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "queued",
          input_path: "research/up.pdf",
          filename: "up.pdf",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:00:00Z",
        },
      ],
    });
    renderStudio();

    const input = screen.getByTestId("studio-upload-input");
    fireEvent.change(input, {
      target: {
        files: [new File(["hello"], "up.pdf", { type: "application/pdf" })],
      },
    });

    await screen.findByText("up.pdf");
    expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    expect(invokeSkillActionMock).toHaveBeenCalledWith("web-abc", "source.import", {
      paths: ["research/up.pdf"],
    });

    const checkbox = screen.getByLabelText(
      "Use up.pdf as source",
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    expect(screen.queryByText(/source selected for notebook grounding/)).toBeNull();
  });

  it("renders a processing source row while a background import job runs", async () => {
    uploadFilesMock.mockResolvedValue(["upload-handle-photo"]);
    invokeSkillActionMock.mockResolvedValue({
      action_id: "source.import",
      ok: true,
      queued: 1,
      jobs: [
        {
          job_id: "job-photo",
          batch_id: "batch-photo",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "queued",
          input_path: "uploads/photo.jpg",
          filename: "photo.jpg",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:00:00Z",
        },
      ],
    });

    renderStudio();
    fireEvent.change(screen.getByTestId("studio-upload-input"), {
      target: {
        files: [new File(["image"], "photo.jpg", { type: "image/jpeg" })],
      },
    });

    await screen.findByText("photo.jpg");
    expect(screen.getByText("Processing")).toBeTruthy();
    const checkbox = screen.getByLabelText(
      "Use photo.jpg as source",
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(
      screen.queryByText(/source selected for notebook grounding/),
    ).toBeNull();
  });

  it("marks a processing source ready when its job succeeds", async () => {
    uploadFilesMock.mockResolvedValue(["upload-handle-photo"]);
    invokeSkillActionMock.mockResolvedValue({
      action_id: "source.import",
      ok: true,
      queued: 1,
      jobs: [
        {
          job_id: "job-photo",
          batch_id: "batch-photo",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "running",
          input_path: "uploads/photo.jpg",
          filename: "photo.jpg",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:00:00Z",
        },
      ],
    });

    renderStudio();
    fireEvent.change(screen.getByTestId("studio-upload-input"), {
      target: {
        files: [new File(["image"], "photo.jpg", { type: "image/jpeg" })],
      },
    });
    await screen.findByText("Processing");

    loadSourceCatalogMock.mockResolvedValue([
      {
        sourceId: "photo",
        filename: "photo.jpg",
        path: "notebook-sources/photo/source.md",
        sourcePath: "notebook-sources/photo/source.md",
        inputPath: "uploads/photo.jpg",
        previewPath: "uploads/photo.jpg",
        timestamp: Date.parse("2026-07-09T01:02:00Z"),
        status: "ready",
      },
    ]);

    fireEvent(
      window,
      new CustomEvent("crew:skill_action_job_updated", {
        detail: {
          job_id: "job-photo",
          batch_id: "batch-photo",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "succeeded",
          input_path: "uploads/photo.jpg",
          filename: "photo.jpg",
          source_id: "photo",
          source_path: "notebook-sources/photo/source.md",
          metadata_path: "notebook-sources/photo/metadata.json",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:02:00Z",
        },
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Processing")).toBeNull();
    });
    const checkbox = screen.getByLabelText(
      "Use photo.jpg as source",
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);
    expect(screen.queryByText(/source selected for notebook grounding/)).toBeNull();
  });

  it("keeps a newly ready source when an older catalog request resolves last", async () => {
    let resolveInitialCatalog: ((rows: unknown[]) => void) | undefined;
    const initialCatalog = new Promise<unknown[]>((resolve) => {
      resolveInitialCatalog = resolve;
    });
    const readyCatalog = [
      {
        sourceId: "photo",
        filename: "photo.jpg",
        path: "notebook-sources/photo/source.md",
        sourcePath: "notebook-sources/photo/source.md",
        inputPath: "uploads/photo.jpg",
        previewPath: "uploads/photo.jpg",
        timestamp: Date.parse("2026-07-09T01:02:00Z"),
        status: "ready" as const,
      },
    ];
    let catalogCalls = 0;
    loadSourceCatalogMock.mockImplementation(() => {
      catalogCalls += 1;
      return catalogCalls === 1 ? initialCatalog : Promise.resolve(readyCatalog);
    });

    renderStudio();
    await waitFor(() => expect(catalogCalls).toBe(1));

    fireEvent(
      window,
      new CustomEvent("crew:skill_action_job_updated", {
        detail: readySourceJob(),
      }),
    );

    await waitFor(() => expect(catalogCalls).toBe(2));
    expect(await screen.findByText("photo.jpg")).toBeTruthy();

    await act(async () => {
      resolveInitialCatalog?.([]);
      await initialCatalog;
    });

    expect(screen.getByText("photo.jpg")).toBeTruthy();
  });

  it("shows a failed source import job error", async () => {
    uploadFilesMock.mockResolvedValue(["upload-handle-photo"]);
    invokeSkillActionMock.mockResolvedValue({
      action_id: "source.import",
      ok: true,
      queued: 1,
      jobs: [
        {
          job_id: "job-photo",
          batch_id: "batch-photo",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "running",
          input_path: "uploads/photo.jpg",
          filename: "photo.jpg",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:00:00Z",
        },
      ],
    });

    renderStudio();
    fireEvent.change(screen.getByTestId("studio-upload-input"), {
      target: {
        files: [new File(["image"], "photo.jpg", { type: "image/jpeg" })],
      },
    });
    await screen.findByText("Processing");

    fireEvent(
      window,
      new CustomEvent("crew:skill_action_job_updated", {
        detail: {
          job_id: "job-photo",
          batch_id: "batch-photo",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "failed",
          input_path: "uploads/photo.jpg",
          filename: "photo.jpg",
          error: "Unsupported image payload",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:02:00Z",
        },
      }),
    );

    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(screen.getByText("Unsupported image payload")).toBeTruthy();
    const checkbox = screen.getByLabelText(
      "Use photo.jpg as source",
    ) as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it("retries a failed source import from its retained session path", async () => {
    mockSourceImportJobs([
      readySourceJob({
        status: "failed",
        source_id: undefined,
        source_path: undefined,
        materialized_path: "uploads/photo.jpg",
        error: "Temporary model failure",
      }),
    ]);
    invokeSkillActionMock.mockResolvedValueOnce({
      action_id: "source.import",
      ok: true,
      queued: 1,
      jobs: [
        readySourceJob({
          job_id: "job-photo-retry",
          status: "queued",
          source_id: undefined,
          source_path: undefined,
        }),
      ],
    });

    renderStudio();
    await screen.findByText("Failed");
    fireEvent.click(screen.getByLabelText("Source actions for photo.jpg"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry import" }));

    await waitFor(() => {
      expect(invokeSkillActionMock).toHaveBeenCalledWith("web-abc", "source.import", {
        paths: ["uploads/photo.jpg"],
      });
    });
    expect(await screen.findByText("Processing")).toBeTruthy();
  });

  it("dismisses failed source import rows without a source id", async () => {
    uploadFilesMock.mockResolvedValue(["upload-handle-photo"]);
    invokeSkillActionMock.mockResolvedValue({
      action_id: "source.import",
      ok: true,
      queued: 1,
      jobs: [
        {
          job_id: "job-photo",
          batch_id: "batch-photo",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "running",
          input_path: "uploads/photo.jpg",
          filename: "photo.jpg",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:00:00Z",
        },
      ],
    });

    renderStudio();
    fireEvent.change(screen.getByTestId("studio-upload-input"), {
      target: {
        files: [new File(["image"], "photo.jpg", { type: "image/jpeg" })],
      },
    });
    await screen.findByText("Processing");

    fireEvent(
      window,
      new CustomEvent("crew:skill_action_job_updated", {
        detail: {
          job_id: "job-photo",
          batch_id: "batch-photo",
          profile_id: "alan0x",
          session_id: "web-abc",
          action_id: "source.import",
          skill_id: "mofa-notebook-source",
          status: "failed",
          input_path: "uploads/photo.jpg",
          filename: "photo.jpg",
          error: "Unsupported image payload",
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:02:00Z",
        },
      }),
    );
    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(screen.getByText("Unsupported image payload")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Source actions for photo.jpg"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from list" }));

    expect(screen.queryByText("photo.jpg")).toBeNull();
    expect(screen.queryByText("Unsupported image payload")).toBeNull();
    expect(invokeSkillActionMock).not.toHaveBeenCalledWith(
      "web-abc",
      "source.remove",
      expect.anything(),
    );

    fireEvent(window, new CustomEvent("crew:skill_action_job_updated", {
      detail: {
        ...readySourceJob({
          job_id: "job-other",
          status: "running",
          source_id: undefined,
          source_path: undefined,
          input_path: "uploads/other.pdf",
          materialized_path: "uploads/other.pdf",
          filename: "other.pdf",
          updated_at: "2026-07-09T01:03:00Z",
        }),
      },
    }));

    expect(await screen.findByText("other.pdf")).toBeTruthy();
    expect(screen.queryByText("photo.jpg")).toBeNull();
    expect(screen.queryByText("Unsupported image payload")).toBeNull();
  });

  it("restores processing source jobs after the bridge reconnects", async () => {
    let sourceRestoreCount = 0;
    listSkillActionJobsMock.mockImplementation(
      (_sessionId: string, options?: { actionId?: string }) => {
        if (options?.actionId !== "source.import") return Promise.resolve([]);
        sourceRestoreCount += 1;
        return Promise.resolve(sourceRestoreCount === 1 ? [] : [
          {
            job_id: "job-restored",
            batch_id: "batch-restored",
            profile_id: "alan0x",
            session_id: "web-abc",
            action_id: "source.import",
            skill_id: "mofa-notebook-source",
            status: "running",
            input_path: "uploads/restored.pdf",
            filename: "restored.pdf",
            created_at: "2026-07-09T01:00:00Z",
            updated_at: "2026-07-09T01:02:00Z",
          },
        ]);
      },
    );

    renderStudio();
    await waitFor(() =>
      expect(listSkillActionJobsMock).toHaveBeenCalledWith("web-abc", {
        actionId: "source.import",
      }),
    );

    fireEvent(window, new Event("crew:bridge_connected"));

    expect(await screen.findByText("restored.pdf")).toBeTruthy();
    expect(screen.getByText("Processing")).toBeTruthy();
    expect(listSkillActionJobsMock).toHaveBeenLastCalledWith("web-abc", {
      actionId: "source.import",
    });
  });

  it("does not regress a succeeded source import when an older running event arrives", async () => {
    const running = readySourceJob({
      status: "running",
      source_id: undefined,
      source_path: undefined,
      updated_at: "2026-07-09T01:02:00Z",
    });
    mockSourceImportJobs([running]);
    renderStudio();

    expect(await screen.findByText("Processing")).toBeTruthy();
    await waitFor(() => expect(loadSourceCatalogMock).toHaveBeenCalled());
    loadSourceCatalogMock.mockResolvedValue([{
      sourceId: "photo",
      filename: "photo.jpg",
      path: "notebook-sources/photo/source.md",
      sourcePath: "notebook-sources/photo/source.md",
      inputPath: "uploads/photo.jpg",
      previewPath: "uploads/photo.jpg",
      timestamp: Date.parse("2026-07-09T01:03:00Z"),
      status: "ready",
    }]);

    fireEvent(window, new CustomEvent("crew:skill_action_job_updated", {
      detail: readySourceJob({ updated_at: "2026-07-09T01:03:00Z" }),
    }));
    await waitFor(() => expect(screen.queryByText("Processing")).toBeNull());

    fireEvent(window, new CustomEvent("crew:skill_action_job_updated", {
      detail: running,
    }));

    fireEvent(window, new CustomEvent("crew:skill_action_job_updated", {
      detail: readySourceJob({ updated_at: "2026-07-09T01:03:00Z" }),
    }));

    await waitFor(() => expect(screen.queryByText("Processing")).toBeNull());
    expect(screen.getAllByText("photo.jpg")).toHaveLength(1);
    expect(loadSourceCatalogMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a processing Source preview open when the ready catalog row takes over", async () => {
    const running = readySourceJob({
      status: "running",
      source_id: undefined,
      source_path: undefined,
      updated_at: "2026-07-09T01:02:00Z",
    });
    mockSourceImportJobs([running]);
    renderStudio();

    await screen.findByText("Processing");
    fireEvent.click(screen.getByRole("button", { name: "Preview photo.jpg" }));
    expect(screen.getByRole("button", { name: "Back to sources" })).toBeTruthy();

    loadSourceCatalogMock.mockResolvedValue([{
      sourceId: "photo",
      filename: "photo.jpg",
      path: "notebook-sources/photo/source.md",
      sourcePath: "notebook-sources/photo/source.md",
      inputPath: "uploads/photo.jpg",
      previewPath: "uploads/photo.jpg",
      timestamp: Date.parse("2026-07-09T01:03:00Z"),
      status: "ready",
    }]);
    fireEvent(window, new CustomEvent("crew:skill_action_job_updated", {
      detail: readySourceJob({ updated_at: "2026-07-09T01:03:00Z" }),
    }));

    expect(await screen.findByRole("button", { name: "Back to sources" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Parsed" })).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("reconciles a legacy succeeded import with its catalog source by materialized path", async () => {
    mockSourceImportJobs([readySourceJob({
      source_id: undefined,
      source_path: undefined,
    })]);
    loadSourceCatalogMock.mockResolvedValue([{
      sourceId: "photo",
      filename: "photo.jpg",
      path: "notebook-sources/photo/source.md",
      sourcePath: "notebook-sources/photo/source.md",
      inputPath: "uploads/photo.jpg",
      previewPath: "uploads/photo.jpg",
      timestamp: Date.parse("2026-07-09T01:03:00Z"),
      status: "ready",
    }]);
    renderStudio();

    await waitFor(() => expect(screen.getAllByText("photo.jpg")).toHaveLength(1));
    const checkbox = screen.getByLabelText("Use photo.jpg as source") as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Quiz" }));

    await waitFor(() => expect(invokeSkillActionMock).toHaveBeenCalledWith(
      "web-abc",
      "quiz.generate",
      { source_ids: ["photo"] },
    ));
  });

  it("keeps a selected source canonical across catalog takeover without duplicate ids", async () => {
    mockSourceImportJobs([readySourceJob({ source_path: undefined })]);
    let resolveCatalog: ((rows: unknown[]) => void) | undefined;
    const catalogPromise = new Promise<unknown[]>((resolve) => {
      resolveCatalog = resolve;
    });
    loadSourceCatalogMock.mockReturnValue(catalogPromise);
    renderStudio();

    const beforeTakeover = await screen.findByLabelText(
      "Use photo.jpg as source",
    ) as HTMLInputElement;
    fireEvent.click(beforeTakeover);
    expect(beforeTakeover.checked).toBe(true);

    await act(async () => {
      resolveCatalog?.([{
        sourceId: "other-photo",
        filename: "other photo.jpg",
        path: "notebook-sources/other-photo/source.md",
        sourcePath: "notebook-sources/other-photo/source.md",
        inputPath: "uploads/photo.jpg",
        previewPath: "uploads/photo.jpg",
        timestamp: 3,
        status: "ready",
      }, {
        sourceId: "photo",
        filename: "photo.jpg",
        path: "notebook-sources/photo/source.md",
        sourcePath: "notebook-sources/photo/source.md",
        inputPath: "uploads/photo.jpg",
        previewPath: "uploads/photo.jpg",
        timestamp: 2,
        status: "ready",
      }]);
      await catalogPromise;
    });

    const afterTakeover = screen.getByLabelText(
      "Use photo.jpg as source",
    ) as HTMLInputElement;
    expect(afterTakeover.checked).toBe(true);
    fireEvent.click(afterTakeover);
    expect(afterTakeover.checked).toBe(false);
    fireEvent.click(afterTakeover);
    fireEvent.click(screen.getByRole("button", { name: "Quiz" }));

    await waitFor(() => expect(invokeSkillActionMock).toHaveBeenCalledWith(
      "web-abc",
      "quiz.generate",
      { source_ids: ["photo"] },
    ));
  });

  it("keeps catalog sources independent when one legacy job path matches both", async () => {
    mockSourceImportJobs([readySourceJob({
      source_id: undefined,
      source_path: undefined,
    })]);
    const sources = [
      {
        sourceId: "photo-a",
        filename: "photo A.jpg",
        path: "notebook-sources/photo-a/source.md",
        sourcePath: "notebook-sources/photo-a/source.md",
        inputPath: "uploads/photo.jpg",
        previewPath: "uploads/photo.jpg",
        timestamp: 2,
        status: "ready" as const,
      },
      {
        sourceId: "photo-b",
        filename: "photo B.jpg",
        path: "notebook-sources/photo-b/source.md",
        sourcePath: "notebook-sources/photo-b/source.md",
        inputPath: "uploads/photo.jpg",
        previewPath: "uploads/photo.jpg",
        timestamp: 1,
        status: "ready" as const,
      },
    ];
    loadSourceCatalogMock.mockResolvedValue(sources);
    renderStudio();

    await screen.findByRole("button", { name: "Preview photo B.jpg" });
    fireEvent.click(screen.getByRole("button", { name: "Preview photo B.jpg" }));
    expect(screen.getByText("photo B.jpg")).toBeTruthy();
    expect(screen.queryByText("photo A.jpg")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to sources" }));

    invokeSkillActionMock.mockResolvedValueOnce({
      action_id: "source.remove",
      ok: true,
      results: [{ success: true, output: "removed" }],
    });
    loadSourceCatalogMock.mockResolvedValue([sources[0]]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByLabelText("Source actions for photo B.jpg"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove source" }));

    await waitFor(() => expect(invokeSkillActionMock).toHaveBeenCalledWith(
      "web-abc",
      "source.remove",
      { source_id: "photo-b" },
    ));
    expect(screen.getByText("photo A.jpg")).toBeTruthy();
    expect(screen.queryByText("photo B.jpg")).toBeNull();
    confirm.mockRestore();
  });

  it("keeps a newer failed source import when an older succeeded event arrives", async () => {
    const failed = readySourceJob({
      status: "failed",
      source_id: undefined,
      source_path: undefined,
      error: "Import failed",
      updated_at: "2026-07-09T01:05:00Z",
    });
    mockSourceImportJobs([failed]);
    renderStudio();

    expect(await screen.findByText("Failed")).toBeTruthy();
    fireEvent(window, new CustomEvent("crew:skill_action_job_updated", {
      detail: readySourceJob({ updated_at: "2026-07-09T01:04:00Z" }),
    }));

    await waitFor(() => expect(screen.getByText("Failed")).toBeTruthy());
    expect(screen.getByText("Import failed")).toBeTruthy();
  });

  it("previews original and parsed source content inside the Sources pane", async () => {
    mockSourceImportJobs();
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["preview"], { type: "image/jpeg" }),
        text: async () =>
          url.includes("notebook-sources%2Fphoto%2Fsource.md")
            ? "# Parsed source"
            : "",
      } as Response;
    });

    renderStudio();

    await screen.findByText("photo.jpg");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sources" }), {
      target: { value: "photo" },
    });
    fireEvent.click(screen.getByLabelText("Preview photo.jpg"));

    const pane = screen.getByTestId("studio-sources-pane");
    expect(within(pane).getByRole("button", { name: "Back to sources" })).toBeTruthy();
    expect(within(pane).getByRole("tab", { name: "Original" })).toBeTruthy();
    expect(within(pane).getByRole("tab", { name: "Parsed" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("chat-thread-stub")).toBeTruthy();

    const image = await screen.findByAltText("photo.jpg source preview");
    expect(image.getAttribute("src")).toBe("blob:studio-preview");
    expect(image.getAttribute("src")).not.toContain("notebook-sources");

    fireEvent.click(within(pane).getByRole("tab", { name: "Parsed" }));
    expect(
      await within(pane).findByRole("heading", { name: "Parsed source" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Toggle sources" }));
    expect(screen.queryByTestId("studio-sources-pane")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle sources" }));
    expect(
      within(screen.getByTestId("studio-sources-pane")).getByRole("button", {
        name: "Back to sources",
      }),
    ).toBeTruthy();

    const reopenedPane = screen.getByTestId("studio-sources-pane");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await within(reopenedPane).findByText("photo.jpg")).toBeTruthy();
    expect((within(reopenedPane).getByRole("searchbox", { name: "Search sources" }) as HTMLInputElement).value).toBe("photo");
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(reopenedPane).getByRole("button", { name: "Preview photo.jpg" }),
      );
    });
  });

  it("renames an imported source through the source rename action", async () => {
    mockSourceImportJobs();
    invokeSkillActionMock.mockResolvedValueOnce({
      action_id: "source.rename",
      ok: true,
      results: [{ success: true, output: "renamed" }],
    });

    renderStudio();
    await screen.findByText("photo.jpg");

    fireEvent.click(screen.getByLabelText("Source actions for photo.jpg"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename source" }));
    fireEvent.change(screen.getByLabelText("Rename source title"), {
      target: { value: "Renamed Photo" },
    });
    loadSourceCatalogMock.mockResolvedValue([
      {
        sourceId: "photo",
        filename: "Renamed Photo",
        path: "notebook-sources/photo/source.md",
        sourcePath: "notebook-sources/photo/source.md",
        inputPath: "uploads/photo.jpg",
        previewPath: "uploads/photo.jpg",
        timestamp: Date.now(),
        status: "ready",
      },
    ]);
    fireEvent.click(screen.getByLabelText("Save source rename"));

    await waitFor(() => {
      expect(invokeSkillActionMock).toHaveBeenCalledWith(
        "web-abc",
        "source.rename",
        { source_id: "photo", title: "Renamed Photo" },
      );
    });
    expect(screen.getByText("Renamed Photo")).toBeTruthy();
  });

  it("removes an imported source through the source remove action", async () => {
    mockSourceImportJobs();
    invokeSkillActionMock.mockResolvedValueOnce({
      action_id: "source.remove",
      ok: true,
      results: [{ success: true, output: "removed" }],
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderStudio();
    await screen.findByText("photo.jpg");
    fireEvent.click(screen.getByLabelText("Use photo.jpg as source"));
    expect(
      screen.getByText(/1 source selected for notebook grounding/),
    ).toBeTruthy();
    loadSourceCatalogMock.mockResolvedValue([]);
    fireEvent.click(screen.getByLabelText("Source actions for photo.jpg"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove source" }));

    await waitFor(() => {
      expect(invokeSkillActionMock).toHaveBeenCalledWith(
        "web-abc",
        "source.remove",
        { source_id: "photo" },
      );
    });
    expect(screen.queryByText("photo.jpg")).toBeNull();
    expect(screen.queryByText(/source selected for notebook grounding/)).toBeNull();
    confirm.mockRestore();
  });
});
