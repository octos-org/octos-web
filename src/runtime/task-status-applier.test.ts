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
});
