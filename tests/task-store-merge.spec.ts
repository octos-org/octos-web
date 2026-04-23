/**
 * B-004 — task-store equal-seq updated_at tiebreak.
 *
 * Scenarios covered:
 *   (a) incoming server_seq > existing server_seq → accept
 *   (b) incoming server_seq == existing server_seq
 *         incoming updated_at is older than existing → REJECT
 *   (c) incoming server_seq == existing server_seq
 *         incoming updated_at is newer than existing → accept
 */

import { expect, test } from "@playwright/test";
import type { BackgroundTaskInfo } from "../src/api/types";
import {
  getTasks,
  mergeTask,
  replaceTasks,
} from "../src/store/task-store";

const SESSION_ID = "unit-task-store-merge";

function baseTask(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    id: "t-merge-1",
    tool_name: "Deep research",
    tool_call_id: "call-merge-1",
    status: "running",
    started_at: "2026-04-20T12:00:00Z",
    completed_at: null,
    output_files: [],
    error: null,
    session_key: `api:${SESSION_ID}`,
    current_phase: "research",
    progress_message: "initial",
    progress: 0.1,
    ...overrides,
  };
}

test.describe("B-004 — mergeTask equal-seq tiebreak on updated_at", () => {
  test("accepts when incoming seq is higher than existing", async () => {
    replaceTasks(SESSION_ID, []);
    mergeTask(SESSION_ID, baseTask({ progress_message: "old" }), undefined, {
      serverSeq: 1,
      updatedAt: "2026-04-20T12:00:01Z",
    });
    mergeTask(
      SESSION_ID,
      baseTask({ progress_message: "new", progress: 0.9 }),
      undefined,
      { serverSeq: 5, updatedAt: "2026-04-20T12:00:05Z" },
    );
    const tasks = getTasks(SESSION_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].progress_message).toBe("new");
  });

  test("rejects when seqs are equal and incoming updated_at is older", async () => {
    replaceTasks(SESSION_ID, []);
    mergeTask(
      SESSION_ID,
      baseTask({ progress_message: "existing-is-newer" }),
      undefined,
      { serverSeq: 7, updatedAt: "2026-04-20T12:05:00Z" },
    );
    mergeTask(
      SESSION_ID,
      baseTask({ progress_message: "stale" }),
      undefined,
      { serverSeq: 7, updatedAt: "2026-04-20T12:00:00Z" },
    );
    const tasks = getTasks(SESSION_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].progress_message).toBe("existing-is-newer");
  });

  test("accepts when seqs are equal and incoming updated_at is newer", async () => {
    replaceTasks(SESSION_ID, []);
    mergeTask(
      SESSION_ID,
      baseTask({ progress_message: "stale-existing" }),
      undefined,
      { serverSeq: 7, updatedAt: "2026-04-20T12:00:00Z" },
    );
    mergeTask(
      SESSION_ID,
      baseTask({ progress_message: "incoming-wins" }),
      undefined,
      { serverSeq: 7, updatedAt: "2026-04-20T12:05:00Z" },
    );
    const tasks = getTasks(SESSION_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].progress_message).toBe("incoming-wins");
  });

  test("accepts when seqs are equal and both updated_at are equal (last-write-wins)", async () => {
    replaceTasks(SESSION_ID, []);
    mergeTask(
      SESSION_ID,
      baseTask({ progress_message: "first" }),
      undefined,
      { serverSeq: 7, updatedAt: "2026-04-20T12:00:00Z" },
    );
    mergeTask(
      SESSION_ID,
      baseTask({ progress_message: "second" }),
      undefined,
      { serverSeq: 7, updatedAt: "2026-04-20T12:00:00Z" },
    );
    const tasks = getTasks(SESSION_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].progress_message).toBe("second");
  });

  test("accepts when seqs are equal and both updated_at are absent", async () => {
    replaceTasks(SESSION_ID, []);
    mergeTask(SESSION_ID, baseTask({ progress_message: "first" }), undefined, {
      serverSeq: 7,
    });
    mergeTask(
      SESSION_ID,
      baseTask({ progress_message: "second" }),
      undefined,
      { serverSeq: 7 },
    );
    const tasks = getTasks(SESSION_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].progress_message).toBe("second");
  });
});
