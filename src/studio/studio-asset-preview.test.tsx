import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SkillActionJob } from "@/api/skill-actions";

vi.mock("./studio-file-preview", () => ({
  StudioFilePreview: ({ filename }: { filename: string }) => (
    <div data-testid="file-preview">{filename}</div>
  ),
}));

import { buildStudioAsset } from "./generated-assets";
import { StudioAssetPreview } from "./studio-asset-preview";

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
    expect(screen.getByTestId("file-preview").textContent).toBe("scene-plan.json");

    fireEvent.click(screen.getByRole("tab", { name: "Assets" }));
    expect(screen.getByTestId("file-preview").textContent).toBe("asset-brief.md");

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getAllByRole("button", { name: /^Download / })).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "Download script.md" }));
    expect(onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "script.md", role: "script" }),
    );
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

  it("shows ordinary generated assets in a compact Preview and Files viewer", () => {
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
    expect(screen.getByTestId("file-preview").textContent).toBe("quiz.md");
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
});
