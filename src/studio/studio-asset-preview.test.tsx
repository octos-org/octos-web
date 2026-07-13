import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SkillActionJob } from "@/api/skill-actions";

vi.mock("./studio-file-preview", () => ({
  StudioFilePreview: ({ filename }: { filename: string }) => (
    <div data-testid="file-preview">{filename}</div>
  ),
}));
vi.mock("./authenticated-text-file", () => ({
  AuthenticatedTextFile: ({ children, file }: { children: (text: string) => React.ReactNode; file?: { filename: string } }) => children(
    file?.filename === "scene-plan.json"
      ? JSON.stringify({ title: "Scenes", scenes: [{ scene: 1, type: "chart", visual: "Chart", narration: "Narration", citations: [] }] })
      : "# Quiz\n\n1. Question?\n   Answer: Answer\n   Explanation: Explanation [Source]",
  ),
}));

import { buildStudioAsset } from "./generated-assets";
import { StudioAssetPreview } from "./studio-asset-preview";
import { StudioSourcePreview } from "./studio-source-preview";

function videoJob(filenames: string[]): SkillActionJob {
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
      artifacts: filenames.map((filename) => ({
        handle: `ws/video/${filename}`,
        display_name: filename,
        media_type: filename.endsWith(".mp4")
          ? "video/mp4"
          : filename.endsWith(".json")
            ? "application/json"
            : "text/markdown",
      })),
    },
    created_at: "2026-07-09T01:00:00Z",
    updated_at: "2026-07-09T01:01:00Z",
  };
}

afterEach(cleanup);

describe("StudioAssetPreview", () => {
  it("moves focus into the preview when it replaces the Studio list", () => {
    const asset = buildStudioAsset(videoJob(["overview.mp4"]));

    render(
      <StudioAssetPreview
        asset={asset}
        sessionId="web-abc"
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back to Studio" }),
    );
  });

  it("organizes every Video Overview output behind one five-tab viewer", () => {
    const asset = buildStudioAsset(
      videoJob([
        "overview.mp4",
        "script.md",
        "scene-plan.json",
        "asset-brief.md",
        "handoff.md",
        "veo-prompt.txt",
        "veo-operation.json",
      ]),
    );
    const onDownload = vi.fn();

    render(
      <StudioAssetPreview
        asset={asset}
        sessionId="web-abc"
        onBack={vi.fn()}
        onDownload={onDownload}
      />,
    );

    for (const tab of ["Overview", "Script", "Scenes", "Assets", "Files"]) {
      expect(screen.getByRole("tab", { name: tab })).toBeTruthy();
    }
    expect(screen.getByTestId("file-preview").textContent).toBe("overview.mp4");

    fireEvent.click(screen.getByRole("tab", { name: "Script" }));
    expect(screen.getByTestId("file-preview").textContent).toBe("script.md");

    fireEvent.click(screen.getByRole("tab", { name: "Scenes" }));
    expect(screen.getByRole("heading", { name: "Scene 1" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));
    expect(screen.getByTestId("file-preview").textContent).toBe("asset-brief.md");

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getAllByRole("button", { name: /^Download / })).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "Download script.md" }));
    expect(onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "script.md", role: "script" }),
    );
  });

  it("moves focus into a Files preview and restores it to the opened file", () => {
    const asset = buildStudioAsset(videoJob(["overview.mp4", "script.md"]));

    render(
      <StudioAssetPreview
        asset={asset}
        sessionId="web-abc"
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const openFile = screen.getByRole("button", { name: "Open file script.md" });
    openFile.focus();
    fireEvent.click(openFile);

    const back = screen.getByRole("button", { name: "Back to files" });
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open file script.md" }),
    );
  });

  it("keeps an opened file selected when a job update inserts an earlier artifact", () => {
    const view = render(
      <StudioAssetPreview
        asset={buildStudioAsset(videoJob(["overview.mp4", "script.md"]))}
        sessionId="web-abc"
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Open file script.md" }));
    expect(screen.getByTestId("file-preview").textContent).toBe("script.md");

    view.rerender(
      <StudioAssetPreview
        asset={buildStudioAsset(videoJob(["notes.md", "overview.mp4", "script.md"]))}
        sessionId="web-abc"
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.getByTestId("file-preview").textContent).toBe("script.md");
    expect(screen.getAllByText("script.md")).toHaveLength(2);
  });

  it("uses roving tab stops and links tabs to their active panel", () => {
    render(
      <StudioAssetPreview
        asset={buildStudioAsset(videoJob(["overview.mp4", "script.md"]))}
        sessionId="web-abc"
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    const overview = screen.getByRole("tab", { name: "Overview" });
    const script = screen.getByRole("tab", { name: "Script" });
    expect(overview.tabIndex).toBe(0);
    expect(script.tabIndex).toBe(-1);
    expect(overview.getAttribute("aria-controls")).toBe(
      screen.getByRole("tabpanel").id,
    );

    fireEvent.click(script);
    expect(overview.tabIndex).toBe(-1);
    expect(script.tabIndex).toBe(0);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(script.id);
  });

  it("keeps plan files useful when Video Overview has no rendered video", () => {
    const asset = buildStudioAsset(videoJob(["script.md", "scene-plan.json"]));

    render(
      <StudioAssetPreview
        asset={asset}
        sessionId="web-abc"
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.getByText("Video rendering unavailable. Plan files are ready."))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Script" }));
    expect(screen.getByTestId("file-preview").textContent).toBe("script.md");
  });

  it("routes Quiz assets to an interactive viewer while retaining Files", () => {
    const asset = buildStudioAsset({
      ...videoJob(["quiz.md"]),
      job_id: "job-quiz",
      action_id: "quiz.generate",
      result: {
        artifacts: [{
          handle: "ws/quiz/quiz.md",
          display_name: "quiz.md",
          media_type: "text/markdown",
        }],
      },
    });

    render(
      <StudioAssetPreview
        asset={asset}
        sessionId="web-abc"
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Back to Studio" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Preview" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show answer" })).toBeTruthy();
  });

  it("keeps download failures visible while the Studio viewer is open", () => {
    const asset = buildStudioAsset(videoJob(["overview.mp4"]));

    render(
      <StudioAssetPreview
        asset={asset}
        sessionId="web-abc"
        downloadError="Download failed (404)"
        onBack={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe("Download failed (404)");
  });

  it("closes only the most recently opened preview when both panels handle Escape", () => {
    const onAssetBack = vi.fn();
    const onSourceBack = vi.fn();
    const asset = buildStudioAsset(videoJob(["overview.mp4"]));

    render(
      <>
        <StudioAssetPreview
          asset={asset}
          sessionId="web-abc"
          onBack={onAssetBack}
          onDownload={vi.fn()}
        />
        <StudioSourcePreview
          row={{
            sourceId: "report",
            filename: "Report.pdf",
            path: "notebook-sources/report/source.md",
            sourcePath: "notebook-sources/report/source.md",
            previewPath: "uploads/report.pdf",
            timestamp: 1,
          }}
          sessionId="web-abc"
          onBack={onSourceBack}
        />
      </>,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onSourceBack).toHaveBeenCalledTimes(1);
    expect(onAssetBack).not.toHaveBeenCalled();
  });
});
