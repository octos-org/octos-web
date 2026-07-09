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
  listSkillActionJobs: listSkillActionJobsMock,
}));

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
  invokeSkillActionMock.mockResolvedValue({
    action_id: "source.import",
    ok: true,
    materialized_paths: ["uploads/up.pdf"],
    results: [{ success: true, output: "captured" }],
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("StudioPage", () => {
  it("renders the 3-pane workspace with the pinned chat and session sources", () => {
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

    // Session-scoped source rows from the file-store fixtures.
    expect(screen.getAllByText("notes.md").length).toBeGreaterThan(0);
    expect(screen.getAllByText("chart.png").length).toBeGreaterThan(0);
    // Files from other sessions never leak in.
    expect(screen.queryByText("other.md")).toBeNull();

    expect(loadSessionFilesMock).toHaveBeenCalledWith("web-abc");
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

  it("updates the grounding footer when a source is checked", () => {
    renderStudio();

    expect(screen.queryByText(/source/, { selector: "p" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Use notes.md as source"));
    expect(
      screen.getByText(/1 source selected for notebook grounding/),
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Use chart.png as source"));
    expect(
      screen.getByText(/2 sources selected for notebook grounding/),
    ).toBeTruthy();

    // Unchecking drops it back down.
    fireEvent.click(screen.getByLabelText("Use chart.png as source"));
    expect(
      screen.getByText(/1 source selected for notebook grounding/),
    ).toBeTruthy();
  });

  it("shows source actions for ready session file rows without source ids", async () => {
    renderStudio();

    const sourcesPane = within(screen.getByTestId("studio-sources-pane"));
    fireEvent.click(sourcesPane.getByLabelText("Source actions for notes.md"));
    expect(sourcesPane.getByRole("menuitem", { name: "Preview" })).toBeTruthy();
    expect(
      sourcesPane.queryByRole("menuitem", { name: "Rename source" }),
    ).toBeNull();

    fireEvent.click(sourcesPane.getByRole("menuitem", { name: "Remove from list" }));

    await waitFor(() => {
      expect(sourcesPane.queryByText("notes.md")).toBeNull();
    });
    expect(invokeSkillActionMock).not.toHaveBeenCalledWith(
      "web-abc",
      "source.remove",
      expect.anything(),
    );
  });

  it("sends the skill prompt through the bridge when a tile is clicked", () => {
    renderStudio();

    const deepResearch = STUDIO_SKILLS.find((s) => s.id === "deep-research");
    expect(deepResearch).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "web-abc",
        text: deepResearch?.prompt,
        media: [],
      }),
    );
  });

  it("disables requiresSources skills until a source is selected", () => {
    renderStudio();

    const dataViz = screen.getByRole("button", {
      name: "Data Viz",
    }) as HTMLButtonElement;
    expect(dataViz.disabled).toBe(true);

    fireEvent.click(dataViz);
    expect(sendMessageMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Use notes.md as source"));
    const dataVizEnabled = screen.getByRole("button", {
      name: "Data Viz",
    }) as HTMLButtonElement;
    expect(dataVizEnabled.disabled).toBe(false);

    fireEvent.click(dataVizEnabled);
    const dataVizSkill = STUDIO_SKILLS.find((s) => s.id === "data-viz");
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "web-abc",
        text: dataVizSkill?.prompt,
        media: [],
      }),
    );
  });

  it("does not send selected notebook sources as turn media attachments", () => {
    renderStudio();

    fireEvent.click(screen.getByLabelText("Use notes.md as source"));
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "web-abc",
        media: [],
      }),
    );
  });

  it("uploads sources, invokes the source import action, lists them, and auto-selects them", async () => {
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
    expect(checkbox.checked).toBe(true);
    expect(
      screen.getByText(/1 source selected for notebook grounding/),
    ).toBeTruthy();
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
    expect(checkbox.checked).toBe(true);
    expect(
      screen.getByText(/1 source selected for notebook grounding/),
    ).toBeTruthy();
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
    listSkillActionJobsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
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

    renderStudio();
    await waitFor(() =>
      expect(listSkillActionJobsMock).toHaveBeenCalledTimes(1),
    );

    fireEvent(window, new Event("crew:bridge_connected"));

    expect(await screen.findByText("restored.pdf")).toBeTruthy();
    expect(screen.getByText("Processing")).toBeTruthy();
    expect(listSkillActionJobsMock).toHaveBeenLastCalledWith("web-abc", {
      actionId: "source.import",
    });
  });

  it("previews the original uploaded file for an imported source", async () => {
    listSkillActionJobsMock.mockResolvedValueOnce([readySourceJob()]);

    renderStudio();

    await screen.findByText("photo.jpg");
    fireEvent.click(screen.getByLabelText("Preview photo.jpg"));

    const image = await screen.findByAltText("photo.jpg source preview");
    expect(image.getAttribute("src")).toBe(
      "/api/files?path=uploads%2Fphoto.jpg&session=web-abc",
    );
    expect(image.getAttribute("src")).not.toContain("notebook-sources");
  });

  it("renames an imported source through the source rename action", async () => {
    listSkillActionJobsMock.mockResolvedValueOnce([readySourceJob()]);
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
    listSkillActionJobsMock.mockResolvedValueOnce([readySourceJob()]);
    invokeSkillActionMock.mockResolvedValueOnce({
      action_id: "source.remove",
      ok: true,
      results: [{ success: true, output: "removed" }],
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderStudio();
    await screen.findByText("photo.jpg");
    expect(
      screen.getByText(/1 source selected for notebook grounding/),
    ).toBeTruthy();
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
