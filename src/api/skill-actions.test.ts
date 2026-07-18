import { beforeEach, describe, expect, it, vi } from "vitest";

const callMethodMock = vi.hoisted(() => vi.fn());
const bridgeMock = vi.hoisted(() => ({ callMethod: callMethodMock }));
const getActiveBridgeMock = vi.hoisted(() => vi.fn(() => bridgeMock));

vi.mock("@/runtime/ui-protocol-runtime", () => ({
  getActiveBridge: getActiveBridgeMock,
}));

import {
  invokeSkillAction,
  listSkillActions,
  listSkillActionJobs,
  readSkillActionJob,
  type SkillActionJob,
} from "./skill-actions";
import { METHODS } from "@/runtime/ui-protocol-bridge";

const JOB: SkillActionJob = {
  job_id: "job-1",
  batch_id: "batch-1",
  profile_id: "alan0x",
  session_id: "web-abc",
  action_id: "source.import",
  skill_id: "mofa-notebook-source",
  status: "queued",
  input_path: "uploads/chart.jpg",
  filename: "chart.jpg",
  created_at: "2026-07-09T01:00:00Z",
  updated_at: "2026-07-09T01:00:00Z",
};

beforeEach(() => {
  callMethodMock.mockReset();
  getActiveBridgeMock.mockClear();
  getActiveBridgeMock.mockReturnValue(bridgeMock);
});

describe("skill action API", () => {
  it("preserves background jobs returned by skill/action/invoke", async () => {
    callMethodMock.mockResolvedValueOnce({
      action_id: "source.import",
      ok: true,
      queued: 1,
      jobs: [JOB],
    });

    const result = await invokeSkillAction("web-abc", "source.import", {
      paths: ["upload-handle-1"],
    });

    expect(callMethodMock).toHaveBeenCalledWith(METHODS.SKILL_ACTION_INVOKE, {
      session_id: "web-abc",
      action_id: "source.import",
      arguments: { paths: ["upload-handle-1"] },
    });
    expect(result.jobs).toEqual([JOB]);
    expect(result.queued).toBe(1);
    expect(getActiveBridgeMock).toHaveBeenCalledWith("web-abc");
  });

  it("lists available actions through the requested session bridge", async () => {
    callMethodMock.mockResolvedValueOnce({
      actions: [{ id: "quiz.generate", label: "Quiz", available: true }],
    });

    const actions = await listSkillActions("web-abc", "studio.skills");

    expect(getActiveBridgeMock).toHaveBeenCalledWith("web-abc");
    expect(callMethodMock).toHaveBeenCalledWith(METHODS.SKILL_ACTION_LIST, {
      session_id: "web-abc",
      surface: "studio.skills",
    });
    expect(actions[0].id).toBe("quiz.generate");
  });

  it("fails closed when another session owns the active bridge", async () => {
    getActiveBridgeMock.mockReturnValueOnce(null);

    await expect(listSkillActionJobs("web-other")).rejects.toThrow(
      "no connected bridge for skill/action/job/list",
    );
    expect(callMethodMock).not.toHaveBeenCalled();
  });

  it("lists skill action jobs for a session", async () => {
    callMethodMock.mockResolvedValueOnce({
      session_id: "web-abc",
      count: 1,
      jobs: [JOB],
    });

    const jobs = await listSkillActionJobs("web-abc");

    expect(callMethodMock).toHaveBeenCalledWith(
      METHODS.SKILL_ACTION_JOB_LIST,
      { session_id: "web-abc" },
    );
    expect(jobs).toEqual([JOB]);
  });

  it("passes optional job list filters through to the backend", async () => {
    callMethodMock.mockResolvedValueOnce({ count: 0, jobs: [] });

    await listSkillActionJobs("web-abc", {
      batchId: "batch-1",
      actionId: "source.import",
    });

    expect(callMethodMock).toHaveBeenCalledWith(
      METHODS.SKILL_ACTION_JOB_LIST,
      {
        session_id: "web-abc",
        batch_id: "batch-1",
        action_id: "source.import",
      },
    );
  });

  it("reads one skill action job", async () => {
    callMethodMock.mockResolvedValueOnce({ job: { ...JOB, status: "succeeded" } });

    const job = await readSkillActionJob("web-abc", "job-1");

    expect(callMethodMock).toHaveBeenCalledWith(
      METHODS.SKILL_ACTION_JOB_READ,
      {
        session_id: "web-abc",
        job_id: "job-1",
      },
    );
    expect(job.status).toBe("succeeded");
  });
});
