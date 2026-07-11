import {
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
      within(screen.getByTestId("studio-rail")).getByText("Running"),
    ).toBeTruthy();
  });

  it("previews and downloads artifacts from completed studio action jobs", async () => {
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
            files_to_send: [
              "notebook-outputs/study/quiz/quiz.md",
            ],
          },
          created_at: "2026-07-09T01:00:00Z",
          updated_at: "2026-07-09T01:01:00Z",
        },
      }),
    );

    expect(await screen.findByText("quiz.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview quiz.md" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download quiz.md" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Preview quiz.md" }));
    const preview = await screen.findByTitle("quiz.md asset preview");
    expect(preview.getAttribute("src")).toBe("blob:studio-preview");
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
                    files_to_send: [
                      "notebook-outputs/study/quiz/restored-quiz.md",
                    ],
                  },
                  created_at: "2026-07-09T01:00:00Z",
                  updated_at: "2026-07-09T01:01:00Z",
                },
              ],
        ),
    );

    renderStudio();

    expect(await screen.findByText("restored-quiz.md")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Preview restored-quiz.md" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Download restored-quiz.md" }),
    ).toBeTruthy();
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

  it("previews the original uploaded file for an imported source", async () => {
    mockSourceImportJobs();

    renderStudio();

    await screen.findByText("photo.jpg");
    fireEvent.click(screen.getByLabelText("Preview photo.jpg"));

    const image = await screen.findByAltText("photo.jpg source preview");
    expect(image.getAttribute("src")).toBe("blob:studio-preview");
    expect(image.getAttribute("src")).not.toContain("notebook-sources");
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
