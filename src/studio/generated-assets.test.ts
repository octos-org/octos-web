import { describe, expect, it } from "vitest";

import type { SkillActionJob } from "@/api/skill-actions";

import { artifactsFromJob, mergeStudioJobs } from "./generated-assets";

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
