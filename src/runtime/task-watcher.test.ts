/**
 * task-watcher unit tests.
 *
 * Coverage:
 *   - `pollSession` with `tasks: []` AND a TaskStore entry already
 *     hydrated by the live `task/updated` envelope: the empty poll
 *     response MUST NOT clobber the live row (2026-05-15 fix).
 *   - `pollSession` with `tasks: [completed]`: the non-empty branch
 *     still calls `replaceTasks` and persists terminal state.
 *
 * Why: server's WS per-turn registry uses `snapshot_excluding` which
 * constructs a fresh `TaskSupervisor` with cleared `session_key`. The
 * `session/tasks.list` filter is `task.session_key == Some(session_key)`,
 * so the response is always `[]` for spawn_only running tasks. Before
 * this fix the watcher's `pollSession` called
 * `TaskStore.replaceTasks(entry.sessionId, [], topic)` and wiped the
 * row that `mergeLiveTask` just hydrated from the live `task/updated`
 * state="running" envelope.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { getSessionTasksSpy, getMessagesSpy } = vi.hoisted(() => ({
  getSessionTasksSpy: vi.fn(),
  getMessagesSpy: vi.fn(),
}));

vi.mock("@/api/sessions", async () => {
  const actual = await vi.importActual<typeof import("@/api/sessions")>(
    "@/api/sessions",
  );
  return {
    ...actual,
    getSessionTasks: getSessionTasksSpy,
    getMessages: getMessagesSpy,
  };
});

import * as TaskStore from "@/store/task-store";
import {
  __getActiveIdsForTest,
  __pollSessionForTest,
  unwatchSession,
  watchSession,
} from "./task-watcher";
import type { BackgroundTaskInfo } from "@/api/types";

const SESSION = "sess-task-watcher";

function clearTaskStoreEntries() {
  // No explicit reset helper — `clearTasks` plus a topic-less call
  // wipes all keys that prefix-match `SESSION`.
  TaskStore.clearTasks(SESSION);
}

beforeEach(() => {
  getSessionTasksSpy.mockReset();
  getMessagesSpy.mockReset();
  getMessagesSpy.mockResolvedValue([]);
  clearTaskStoreEntries();
});

afterEach(() => {
  // Unwatch to stop the interval timer leaking across tests.
  unwatchSession(SESSION);
  clearTaskStoreEntries();
});

describe("pollSession empty-response defence (2026-05-15)", () => {
  it("does NOT clobber a live-hydrated running task when server returns []", async () => {
    // Simulate live wire path: `mergeLiveTask` from a `task/updated`
    // state="running" envelope has hydrated TaskStore. The watcher
    // poll then fires and the server returns [] because
    // `snapshot_excluding` cleared `session_key`.
    const liveTask: BackgroundTaskInfo = {
      id: "task_pipeline_live",
      tool_name: "deep_research",
      tool_call_id: "task_pipeline_live",
      status: "running",
      started_at: "2026-05-15T00:00:00Z",
      error: null,
    };
    TaskStore.mergeTask(SESSION, liveTask);
    expect(TaskStore.getTasks(SESSION).map((t) => t.id)).toEqual([
      "task_pipeline_live",
    ]);

    getSessionTasksSpy.mockResolvedValue([] as BackgroundTaskInfo[]);

    watchSession(SESSION);
    // Drive one poll cycle synchronously via the test helper so the
    // assertion observes the post-`replaceTasks` state.
    await __pollSessionForTest(SESSION);

    // After the empty poll: the live row MUST still be present.
    const tasks = TaskStore.getTasks(SESSION);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task_pipeline_live");
    expect(tasks[0].status).toBe("running");
  });

  it("rolls pipeline children up under parent in activeIds (WEB-NEW-18)", async () => {
    // Server returns 1 parent + 3 children sharing a tool_call_id.
    // The watcher's `activeIds` Set must reflect the rolled-up count
    // (1) so any consumer reading `activeIds.size` gets the same value
    // the dock renders.
    const family: BackgroundTaskInfo[] = [
      {
        id: "parent-X",
        tool_name: "run_pipeline",
        tool_call_id: "call_X",
        status: "running",
        started_at: "2026-05-24T00:00:00Z",
        error: null,
      },
      {
        id: "child-X-1",
        tool_name: "pipeline:analyze",
        tool_call_id: "call_X",
        status: "running",
        started_at: "2026-05-24T00:00:01Z",
        error: null,
      },
      {
        id: "child-X-2",
        tool_name: "pipeline:synthesize",
        tool_call_id: "call_X",
        status: "running",
        started_at: "2026-05-24T00:00:02Z",
        error: null,
      },
      {
        id: "child-X-3",
        tool_name: "pipeline:plan_and_search",
        tool_call_id: "call_X",
        status: "running",
        started_at: "2026-05-24T00:00:03Z",
        error: null,
      },
    ];
    getSessionTasksSpy.mockResolvedValue(family);

    watchSession(SESSION);
    await __pollSessionForTest(SESSION);

    // TaskStore still holds the full set (it's the raw server view).
    const stored = TaskStore.getTasks(SESSION);
    expect(stored).toHaveLength(4);

    // The watcher's internal `activeIds` MUST hold exactly the
    // rolled-up representative (the parent) — not 4 entries. This
    // assertion is on the actual private state via the test-only
    // accessor, so it'll catch a regression where
    // `updateActiveIds` stops calling the rollup helper.
    const activeIds = __getActiveIdsForTest(SESSION);
    expect(activeIds).not.toBeNull();
    expect(activeIds!.size).toBe(1);
    expect([...activeIds!]).toEqual(["parent-X"]);
  });

  it("non-empty response still calls replaceTasks and writes terminal state", async () => {
    // The non-empty branch must remain unchanged: a watcher poll that
    // sees a completed task should overwrite the live row with the
    // server's authoritative terminal payload.
    const liveTask: BackgroundTaskInfo = {
      id: "task_pipeline_done",
      tool_name: "deep_research",
      tool_call_id: "task_pipeline_done",
      status: "running",
      started_at: "2026-05-15T00:00:00Z",
      error: null,
    };
    TaskStore.mergeTask(SESSION, liveTask);

    const completed: BackgroundTaskInfo = {
      ...liveTask,
      status: "completed",
      completed_at: "2026-05-15T00:00:10Z",
      output_files: ["/tmp/result.json"],
    };
    getSessionTasksSpy.mockResolvedValue([completed]);

    watchSession(SESSION);
    await __pollSessionForTest(SESSION);

    const tasks = TaskStore.getTasks(SESSION);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task_pipeline_done");
    expect(tasks[0].status).toBe("completed");
    expect(tasks[0].output_files).toEqual(["/tmp/result.json"]);
  });
});
