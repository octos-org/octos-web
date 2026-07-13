import { describe, expect, it } from "vitest";

import type { SkillActionJob } from "@/api/skill-actions";

import {
  artifactsFromJob,
  buildStudioAssets,
  mergeStudioJobs,
} from "./generated-assets";

function job(overrides: Partial<SkillActionJob> = {}): SkillActionJob {
  return {
    job_id: "job-1",
    batch_id: "batch-1",
    profile_id: "alan0x",
    session_id: "web-abc",
    action_id: "quiz.generate",
    skill_id: "mofa-notebook-study",
    status: "running",
    created_at: "2026-07-09T01:00:00.000000Z",
    updated_at: "2026-07-09T01:00:00.000000Z",
    ...overrides,
  };
}

describe("generated assets", () => {
  it("groups every Video Overview file into one ready logical asset", () => {
    const [asset] = buildStudioAssets([
      job({
        job_id: "job-video",
        action_id: "video_overview.generate",
        status: "succeeded",
        result: {
          title: "Market overview",
          artifacts: [
            ["overview.mp4", "video/mp4", 1000],
            ["script.md", "text/markdown", 100],
            ["scene-plan.json", "application/json", 200],
            ["asset-brief.md", "text/markdown", 100],
            ["handoff.md", "text/markdown", 100],
            ["veo-prompt.txt", "text/plain", 100],
            ["veo-operation.json", "application/json", 200],
          ].map(([display_name, media_type, size]) => ({
            handle: `ws/video/${display_name}`,
            display_name,
            media_type,
            size,
          })),
        },
      }),
    ]);

    expect(asset).toMatchObject({
      id: "job-video",
      actionId: "video_overview.generate",
      kind: "video-overview",
      title: "Market overview",
      status: "ready",
    });
    expect(asset.files).toHaveLength(7);
    expect(asset.primary?.role).toBe("video");
    expect(asset.defaultDownload?.role).toBe("video");
    expect(asset.files.find((file) => file.role === "scene-plan")).toMatchObject({
      mediaType: "application/json",
      size: 200,
    });
  });

  it("marks a Video Overview with plan files but no video as partial", () => {
    const [asset] = buildStudioAssets([
      job({
        action_id: "video_overview.generate",
        status: "succeeded",
        result: {
          artifacts: [
            {
              handle: "ws/video/script.md",
              display_name: "script.md",
              media_type: "text/markdown",
              size: 100,
            },
          ],
        },
      }),
    ]);

    expect(asset.status).toBe("partial");
    expect(asset.primary?.role).toBe("script");
  });

  it("recognizes a renamed Video Overview MP4 from its MIME and handle", () => {
    const [asset] = buildStudioAssets([
      job({
        action_id: "video_overview.generate",
        status: "succeeded",
        result: {
          artifacts: [{
            handle: "ws/video/overview.mp4",
            display_name: "Rendered video",
            media_type: "video/mp4",
          }],
        },
      }),
    ]);

    expect(asset.status).toBe("ready");
    expect(asset.primary).toMatchObject({
      filename: "Rendered video",
      role: "video",
    });
  });

  it("prefers an explicit artifact role over filename inference", () => {
    const [asset] = buildStudioAssets([
      job({
        action_id: "video_overview.generate",
        status: "succeeded",
        result: {
          artifacts: [{
            handle: "ws/video/output.bin",
            display_name: "Narration notes",
            media_type: "application/octet-stream",
            role: "script",
          }],
        },
      }),
    ]);

    expect(asset.files[0].role).toBe("script");
    expect(asset.primary?.role).toBe("script");
  });

  it("keeps active jobs as one generating asset", () => {
    const [asset] = buildStudioAssets([
      job({ action_id: "reports.generate", status: "running" }),
    ]);

    expect(asset).toMatchObject({
      id: "job-1",
      kind: "report",
      title: "Reports",
      status: "generating",
      files: [],
    });
  });

  it("groups unknown action files into one generic asset", () => {
    const [asset] = buildStudioAssets([
      job({
        action_id: "custom.generate",
        status: "succeeded",
        result: {
          artifacts: [
            {
              handle: "ws/custom/a.txt",
              display_name: "a.txt",
              media_type: "text/plain",
              size: 10,
            },
            {
              handle: "ws/custom/b.json",
              display_name: "b.json",
              media_type: "application/json",
              size: 20,
            },
          ],
        },
      }),
    ]);

    expect(asset.kind).toBe("generic");
    expect(asset.files).toHaveLength(2);
    expect(asset.status).toBe("ready");
  });

  it("exposes artifacts only after the job succeeds", () => {
    const result = {
      artifacts: [{
        handle: "ws/bm90ZWJvb2stb3V0cHV0cy9xdWl6Lm1k/quiz.md",
        display_name: "quiz.md",
        media_type: "text/markdown",
        size: 42,
      }],
    };

    expect(artifactsFromJob(job({ status: "running", result }))).toEqual([]);
    expect(artifactsFromJob(job({ status: "succeeded", result }))).toHaveLength(1);
  });

  it("uses the server-provided artifact display name and handle", () => {
    const [artifact] = artifactsFromJob(job({
      status: "succeeded",
      result: {
        artifacts: [{
          handle: "ws/cXVpei5tZA/quiz.md",
          display_name: "Quiz answer key.md",
          media_type: "text/markdown",
          size: 42,
        }],
      },
    }));

    expect(artifact).toMatchObject({
      filename: "Quiz answer key.md",
      filePath: "ws/cXVpei5tZA/quiz.md",
      mediaType: "text/markdown",
    });
  });

  it.each([
    "/Users/alan0x/.octos/private.md",
    "C:/Users/alan0x/private.md",
    "notebook-outputs/../private.md",
  ])("rejects unsafe artifact path %s", (filePath) => {
    expect(
      artifactsFromJob(
        job({ status: "succeeded", result: { files_to_send: [filePath] } }),
      ),
    ).toEqual([]);
  });

  it("does not regress a terminal job to an active status", () => {
    const succeeded = job({
      status: "succeeded",
      updated_at: "2026-07-09T01:01:00.000000Z",
    });
    const lateRunning = job({
      status: "running",
      updated_at: "2026-07-09T01:02:00.000000Z",
    });

    expect(mergeStudioJobs([succeeded], [lateRunning]))
      .toHaveProperty("0.status", "succeeded");
  });

  it("preserves sub-millisecond ordering when merging updates", () => {
    const earlier = job({
      status: "running",
      updated_at: "2026-07-09T01:00:00.000001Z",
    });
    const later = job({
      status: "succeeded",
      updated_at: "2026-07-09T01:00:00.000002Z",
    });

    expect(mergeStudioJobs([later], [earlier]))
      .toHaveProperty("0.status", "succeeded");
  });
});
