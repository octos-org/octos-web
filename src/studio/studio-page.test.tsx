import {
  cleanup,
  fireEvent,
  render,
  screen,
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
const uploadFilesMock = vi.hoisted(() =>
  vi.fn(async () => ["research/up.pdf"]),
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
  ChatThread: () => <div data-testid="chat-thread-stub" />,
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
vi.mock("@/store/file-store", () => ({
  useAllFiles: () => fileFixtures,
  loadSessionFiles: loadSessionFilesMock,
}));
vi.mock("@/api/chat", () => ({
  uploadFiles: uploadFilesMock,
}));

import { STUDIO_SKILLS } from "./skills";
import { StudioPage } from "./studio-page";

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
  loadSessionFilesMock.mockClear();
  uploadFilesMock.mockClear();
  uploadFilesMock.mockResolvedValue(["research/up.pdf"]);
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
    expect(screen.getByTestId("studio-sources-pane")).toBeTruthy();
    expect(screen.getByTestId("studio-rail")).toBeTruthy();
    expect(screen.getByTestId("studio-title").textContent).toBe("My Research");

    // Session-scoped source rows from the file-store fixtures.
    expect(screen.getAllByText("notes.md").length).toBeGreaterThan(0);
    expect(screen.getAllByText("chart.png").length).toBeGreaterThan(0);
    // Files from other sessions never leak in.
    expect(screen.queryByText("other.md")).toBeNull();

    expect(loadSessionFilesMock).toHaveBeenCalledWith("web-abc");
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
      screen.getByText(/1 source attach to your next message/),
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Use chart.png as source"));
    expect(
      screen.getByText(/2 sources attach to your next message/),
    ).toBeTruthy();

    // Unchecking drops it back down.
    fireEvent.click(screen.getByLabelText("Use chart.png as source"));
    expect(
      screen.getByText(/1 source attach to your next message/),
    ).toBeTruthy();
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
    // The selected source MUST ride along as turn media: skill sends
    // bypass the composer (and therefore beforeSend), so the rail
    // attaches the selection itself.
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "web-abc",
        text: dataVizSkill?.prompt,
        media: ["research/notes.md"],
      }),
    );
  });

  it("attaches the selection to every skill send, not just gated ones", () => {
    renderStudio();

    fireEvent.click(screen.getByLabelText("Use notes.md as source"));
    fireEvent.click(screen.getByRole("button", { name: "Deep Research" }));

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "web-abc",
        media: ["research/notes.md"],
      }),
    );
  });

  it("uploads sources, lists them, and auto-selects them for grounding", async () => {
    renderStudio();

    const input = screen.getByTestId("studio-upload-input");
    fireEvent.change(input, {
      target: {
        files: [new File(["hello"], "up.pdf", { type: "application/pdf" })],
      },
    });

    await screen.findByText("up.pdf");
    expect(uploadFilesMock).toHaveBeenCalledTimes(1);

    const checkbox = screen.getByLabelText(
      "Use up.pdf as source",
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(
      screen.getByText(/1 source attach to your next message/),
    ).toBeTruthy();
  });
});
