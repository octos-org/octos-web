/**
 * task-status-applier unit tests.
 *
 * Coverage:
 *   - `applyTaskStatusToThreadStore` mirrors a `crew:task_status` payload
 *     into ThreadStore: synthetic progress line + terminal status flip.
 *
 * This is the live-event counterpart to the `handleSpawnComplete` fix in
 * `ui-protocol-event-router.test.ts`. Both paths converge on the same
 * `ThreadStore.setToolCallStatus(...)` call; this file exercises the
 * `crew:task_status` route that `runtime-provider.tsx` dispatches into
 * via the extracted helper.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as ThreadStore from "@/store/thread-store";
import {
  __resetTaskStatusDedupForTest,
  applyTaskStatusToThreadStore,
} from "./task-status-applier";
import { handleToolStarted, __resetTurnMetaForTest } from "./ui-protocol-event-router";
import type { BackgroundTaskInfo } from "@/api/types";

const SESSION = "sess-runtime-provider";

afterEach(() => {
  ThreadStore.__resetForTests();
  __resetTaskStatusDedupForTest();
  __resetTurnMetaForTest();
});

function seedToolCall(cmid: string, toolCallId: string, toolName: string) {
  // Realistic spawn_only setup: ack bubble finalized, then tool/started
  // for the long-running background tool lands on the finalized response.
  ThreadStore.addUserMessage(SESSION, {
    text: "ask",
    clientMessageId: cmid,
  });
  ThreadStore.appendAssistantToken(cmid, "Started.");
  ThreadStore.finalizeAssistant(cmid, { committedSeq: 1 });
  handleToolStarted(
    { sessionId: SESSION },
    {
      session_id: SESSION,
      turn_id: cmid,
      tool_call_id: toolCallId,
      tool_name: toolName,
    },
  );
}

describe("applyTaskStatusToThreadStore", () => {
  it(
    "task.status=completed flips the originating tool call status to complete",
    () => {
      // This is the live-event counterpart to the
      // `turn/spawn_complete` stuck-spinner bug (codex 2026-05-15). The
      // synthetic progress line at runtime-provider.tsx:~81 says
      // "completed" — pre-fix the chip TEXT said completed but
      // `toolCall.status` stayed on "running", so every spinner gated
      // on `status === "running"` kept spinning.
      const cmid = "cmid-live-1";
      const taskId = "task_pipeline_1";
      seedToolCall(cmid, taskId, "run_pipeline");

      const task: BackgroundTaskInfo = {
        id: taskId,
        tool_name: "run_pipeline",
        tool_call_id: taskId,
        status: "completed",
        started_at: "2026-05-15T00:00:00Z",
        completed_at: "2026-05-15T00:00:05Z",
        error: null,
      };
      applyTaskStatusToThreadStore(SESSION, undefined, task);

      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find((c) => c.id === taskId);
      expect(tc?.status).toBe("complete");
    },
  );

  it("task.status=failed flips the originating tool call status to error", () => {
    const cmid = "cmid-live-2";
    const taskId = "task_pipeline_2";
    seedToolCall(cmid, taskId, "deep_research");

    const task: BackgroundTaskInfo = {
      id: taskId,
      tool_name: "deep_research",
      tool_call_id: taskId,
      status: "failed",
      started_at: "2026-05-15T00:00:00Z",
      error: "upstream returned 500",
    };
    applyTaskStatusToThreadStore(SESSION, undefined, task);

    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.responses[0].toolCalls.find((c) => c.id === taskId);
    expect(tc?.status).toBe("error");
  });

  it("task.status=running does NOT flip status (the chip is correctly running)", () => {
    const cmid = "cmid-live-3";
    const taskId = "task_pipeline_3";
    seedToolCall(cmid, taskId, "podcast_generate");

    const task: BackgroundTaskInfo = {
      id: taskId,
      tool_name: "podcast_generate",
      tool_call_id: taskId,
      status: "running",
      started_at: "2026-05-15T00:00:00Z",
      error: null,
    };
    applyTaskStatusToThreadStore(SESSION, undefined, task);

    const [thread] = ThreadStore.getThreads(SESSION);
    const tc = thread.responses[0].toolCalls.find((c) => c.id === taskId);
    expect(tc?.status).toBe("running");
  });

  it("task with no tool_call_id is a no-op (no orphan thread mint)", () => {
    const task: BackgroundTaskInfo = {
      id: "task-orphan",
      tool_name: "deep_search",
      tool_call_id: undefined,
      status: "completed",
      started_at: "2026-05-15T00:00:00Z",
      error: null,
    };
    // Should not throw and should not produce any thread.
    applyTaskStatusToThreadStore(SESSION, undefined, task);
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(0);
  });

  it("task whose tool_call_id is unknown to ThreadStore is dropped, not orphaned", () => {
    // Pre-fix the synthetic line was dropped silently when the lookup
    // missed; we deliberately do not synthesize orphan threads here
    // because the real `tool/started` arrives moments later.
    const task: BackgroundTaskInfo = {
      id: "task-stranger",
      tool_name: "fm_tts",
      tool_call_id: "tc-unknown-to-store",
      status: "completed",
      started_at: "2026-05-15T00:00:00Z",
      error: null,
    };
    applyTaskStatusToThreadStore(SESSION, undefined, task);
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Codex final-3 gap 3: dedupe entry must be recorded AFTER the lookup +
  // status flip actually applied — never before.
  // -------------------------------------------------------------------------
  //
  // Pre-fix sequence:
  //   1. task-watcher polls /tasks, gets `completed`. Dispatches
  //      `crew:task_status` → applyTaskStatusToThreadStore.
  //   2. `synthesizeTaskProgressLine` writes
  //      `lastTaskStatusById.set(task.id, "completed")` BEFORE the
  //      `findThreadIdForToolCall` lookup.
  //   3. lookup MISSES (tool/started hasn't landed yet). Function
  //      returns without flipping status.
  //   4. tool/started arrives a tick later. Chip is in `running`.
  //   5. task-watcher polls AGAIN, sees same `completed` row. Dispatches
  //      `crew:task_status` again → `previous === task.status === "completed"`,
  //      synthesizeTaskProgressLine returns null → ENTIRE applier
  //      no-ops. Chip stays running forever.
  //
  // Post-fix: dedupe entry is only recorded after `setToolCallStatus`
  // confirms it applied. The retry at step 5 gets to try again, finds
  // the chip, and flips status to "complete".
  it(
    "completed task BEFORE tool/started is retried AFTER tool/started arrives (codex final-3 gap 3)",
    () => {
      const cmid = "cmid-retry-after-arrival";
      const taskId = "task_retry_after_arrival";

      // Step 1: user prompt seeded, but tool/started has NOT landed.
      ThreadStore.addUserMessage(SESSION, {
        text: "ask",
        clientMessageId: cmid,
      });
      ThreadStore.appendAssistantToken(cmid, "Started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 1 });

      // Step 2: task-watcher poll #1 arrives BEFORE tool/started.
      const completedTask: BackgroundTaskInfo = {
        id: taskId,
        tool_name: "podcast_generate",
        tool_call_id: taskId,
        status: "completed",
        started_at: "2026-05-15T00:00:00Z",
        completed_at: "2026-05-15T00:00:05Z",
        error: null,
      };
      applyTaskStatusToThreadStore(SESSION, undefined, completedTask);

      // Step 3: tool/started lands. Chip is in "running".
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: taskId,
          tool_name: "podcast_generate",
        },
      );
      expect(
        ThreadStore.getThreads(SESSION)[0].responses[0].toolCalls.find(
          (c) => c.id === taskId,
        )?.status,
      ).toBe("running");

      // Step 4: task-watcher poll #2 fires (same row, same status).
      // Pre-fix: dedupe map already says "completed", so synthesize
      // returns null and applier no-ops → chip stuck on "running".
      // Post-fix: dedupe was NOT recorded because the lookup missed
      // last time → this retry actually flips the chip to "complete".
      applyTaskStatusToThreadStore(SESSION, undefined, completedTask);

      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find((c) => c.id === taskId);
      expect(tc?.status).toBe("complete");
    },
  );

  it(
    "failed task BEFORE tool/started is retried AFTER tool/started arrives (codex final-3 gap 3)",
    () => {
      // Symmetric: same gap for the `failed` terminal state.
      const cmid = "cmid-retry-failed";
      const taskId = "task_retry_failed";
      ThreadStore.addUserMessage(SESSION, {
        text: "ask",
        clientMessageId: cmid,
      });
      ThreadStore.appendAssistantToken(cmid, "Started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 1 });

      const failedTask: BackgroundTaskInfo = {
        id: taskId,
        tool_name: "deep_search",
        tool_call_id: taskId,
        status: "failed",
        started_at: "2026-05-15T00:00:00Z",
        error: "upstream 500",
      };
      // Poll #1: tool not yet in store → lookup misses → no dedupe record.
      applyTaskStatusToThreadStore(SESSION, undefined, failedTask);

      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: taskId,
          tool_name: "deep_search",
        },
      );

      // Poll #2: tool exists now → flip status to "error".
      applyTaskStatusToThreadStore(SESSION, undefined, failedTask);

      const [thread] = ThreadStore.getThreads(SESSION);
      const tc = thread.responses[0].toolCalls.find((c) => c.id === taskId);
      expect(tc?.status).toBe("error");
    },
  );

  it(
    "completed task AFTER successful flip suppresses identical replays (dedupe still works)",
    () => {
      // Defensive: confirm the dedupe still suppresses pathological
      // bursts of identical `completed` rows on the same row after the
      // first flip applied. The fix only delays the dedupe — it must
      // still kick in once the status has been written.
      const cmid = "cmid-dedupe-after-flip";
      const taskId = "task_dedupe_after_flip";
      ThreadStore.addUserMessage(SESSION, {
        text: "ask",
        clientMessageId: cmid,
      });
      ThreadStore.appendAssistantToken(cmid, "Started.");
      ThreadStore.finalizeAssistant(cmid, { committedSeq: 1 });
      handleToolStarted(
        { sessionId: SESSION },
        {
          session_id: SESSION,
          turn_id: cmid,
          tool_call_id: taskId,
          tool_name: "fm_tts",
        },
      );

      const completedTask: BackgroundTaskInfo = {
        id: taskId,
        tool_name: "fm_tts",
        tool_call_id: taskId,
        status: "completed",
        started_at: "2026-05-15T00:00:00Z",
        completed_at: "2026-05-15T00:00:05Z",
        error: null,
      };
      applyTaskStatusToThreadStore(SESSION, undefined, completedTask);
      // First flip applied.
      expect(
        ThreadStore.getThreads(SESSION)[0].responses[0].toolCalls.find(
          (c) => c.id === taskId,
        )?.status,
      ).toBe("complete");

      // Count progress entries before the replay.
      const beforeProgressCount =
        ThreadStore.getThreads(SESSION)[0].responses[0].toolCalls.find(
          (c) => c.id === taskId,
        )?.progress?.length ?? 0;

      // Replay 1: should be deduped (no extra progress line, no extra
      // status churn).
      applyTaskStatusToThreadStore(SESSION, undefined, completedTask);
      // Replay 2: still deduped.
      applyTaskStatusToThreadStore(SESSION, undefined, completedTask);

      const afterProgressCount =
        ThreadStore.getThreads(SESSION)[0].responses[0].toolCalls.find(
          (c) => c.id === taskId,
        )?.progress?.length ?? 0;
      expect(afterProgressCount).toBe(beforeProgressCount);
    },
  );
});
