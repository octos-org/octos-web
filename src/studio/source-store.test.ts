import { describe, expect, it } from "vitest";

import type { SkillActionInvokeResponse, SkillActionJob } from "@/api/skill-actions";

import { parseSourceCatalog, reconcileSourceRows } from "./source-store";

const CATALOG_RESPONSE: SkillActionInvokeResponse = {
  action_id: "source.list",
  ok: true,
  results: [
    {
      success: true,
      output: "one source",
      structured_metadata: {
        source_count: 1,
        sources: [
          {
            id: "report",
            display_name: "Q2 report",
            title: "Q2 report",
            kind: "pdf",
            media_type: "application/pdf",
            original_path: "uploads/report.pdf",
            preview_path: "uploads/report.pdf",
            source_path: "notebook-sources/report/source.md",
            metadata_path: "notebook-sources/report/metadata.json",
            chunks_path: "notebook-sources/report/chunks.jsonl",
            created_at: "2026-07-09T01:00:00Z",
            updated_at: "2026-07-09T02:00:00Z",
            retry_input: { path: "uploads/report.pdf", source_id: "report" },
          },
        ],
      },
    },
  ],
};

function job(status: SkillActionJob["status"]): SkillActionJob {
  return {
    job_id: `job-${status}`,
    batch_id: "batch-a",
    profile_id: "alan0x",
    session_id: "web-abc",
    action_id: "source.import",
    skill_id: "mofa-notebook-source",
    status,
    input_path: `uploads/${status}.pdf`,
    filename: `${status}.pdf`,
    created_at: "2026-07-09T01:00:00Z",
    updated_at: "2026-07-09T01:00:01Z",
  };
}

describe("Studio source store", () => {
  it("parses the source.list structured result into ready rows", () => {
    const catalog = parseSourceCatalog(CATALOG_RESPONSE);

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      sourceId: "report",
      filename: "Q2 report",
      path: "notebook-sources/report/source.md",
      previewPath: "uploads/report.pdf",
      status: "ready",
    });
  });

  it("uses jobs only for transient and failed rows", () => {
    const rows = reconcileSourceRows(parseSourceCatalog(CATALOG_RESPONSE), [
      job("queued"),
      job("failed"),
      job("abandoned"),
      job("succeeded"),
    ]);

    expect(rows.map((row) => row.status)).toEqual([
      "ready",
      "processing",
      "failed",
      "abandoned",
    ]);
    expect(rows.filter((row) => row.status === "ready")).toHaveLength(1);
  });
});
