import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssetFile } from "./generated-assets";

vi.mock("@/api/client", () => ({
  buildApiHeaders: () => ({ Authorization: "Bearer test-token" }),
}));
vi.mock("@/api/files", () => ({
  buildFileUrl: (path: string) => `/api/files/${encodeURIComponent(path)}`,
}));

import { AuthenticatedTextFile } from "./authenticated-text-file";

const JOB = {
  job_id: "job-report",
  batch_id: "batch-report",
  profile_id: "alan0x",
  session_id: "web-abc",
  action_id: "report.generate",
  skill_id: "notebook-report",
  status: "succeeded" as const,
  created_at: "2026-07-13T01:00:00Z",
  updated_at: "2026-07-13T01:01:00Z",
};

function reportFile(filePath = "reports/report.md"): AssetFile {
  return {
    id: filePath,
    filename: "report.md",
    filePath,
    mediaType: "text/markdown",
    size: 12,
    role: "primary",
    job: JOB,
  };
}

describe("AuthenticatedTextFile", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => "Report body",
    }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not refetch when a parent recreates an equivalent file object", async () => {
    const view = render(
      <AuthenticatedTextFile file={reportFile()} sessionId="web-abc" empty="Missing">
        {(text) => <p>{text}</p>}
      </AuthenticatedTextFile>,
    );
    await screen.findByText("Report body");

    view.rerender(
      <AuthenticatedTextFile file={reportFile()} sessionId="web-abc" empty="Missing">
        {(text) => <p>{text}</p>}
      </AuthenticatedTextFile>,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });
});
