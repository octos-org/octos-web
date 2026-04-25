import { expect, test } from "@playwright/test";
import type { BackgroundTaskInfo, MessageInfo } from "../src/api/types";
import * as MessageStore from "../src/store/message-store";
import type { Message } from "../src/store/message-store";
import { applyFinalizeAssistant } from "../src/store/message-store-actions";
import {
  convertApiMessage,
  createLocalMessage,
  findFileResultTargetIndex,
  findMessageIndexForFilePath,
  findNoSeqDuplicateIndex,
  findOptimisticMatchIndex,
  findTaskAnchorIndex,
  isAssistantCompanionForFileMessage,
  mergeAssistantDuplicate,
  mergeFileResultIntoTarget,
  mergeTaskAnchorMeta,
  pathMatchKeys,
  projectTaskAnchorMessage,
  sameTaskAnchorMeta,
  shouldCollapseAuthoritativeDuplicate,
  sortedMessagesForDisplay,
  taskIdentity,
} from "../src/store/message-store-reducer";
import {
  reduceAppendAssistantTextEvent,
  reduceEnsureStreamingAssistantEvent,
  reduceStopStreamingAssistantEvent,
} from "../src/store/message-store-reducers/assistant-turn-reducer";
import { reduceProjectTaskAnchorEvent } from "../src/store/message-store-reducers/background-task-reducer";
import { reduceAppendFileArtifactEvent } from "../src/store/message-store-reducers/file-artifact-reducer";
import {
  reduceConvertHistoryReplayMessageEvent,
  reduceMergeAuthoritativeHistoryMessageEvent,
} from "../src/store/message-store-reducers/history-replay-reducer";
import { reduceCreateUserMessageEvent } from "../src/store/message-store-reducers/user-message-reducer";

const NOW = Date.parse("2026-04-20T12:00:30.000Z");

function fixedNow(): number {
  return NOW;
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: "message",
    role: "assistant",
    text: "",
    files: [],
    toolCalls: [],
    status: "complete",
    timestamp: Date.parse("2026-04-20T12:00:00.000Z"),
    ...overrides,
  };
}

function makeApiMessage(overrides: Partial<MessageInfo>): MessageInfo {
  return {
    role: "assistant",
    content: "api message",
    timestamp: "2026-04-20T12:00:00.000Z",
    ...overrides,
  };
}

function makeTask(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    id: "task-deep-research",
    tool_name: "Deep research",
    tool_call_id: "call-deep-research",
    status: "running",
    started_at: "2026-04-20T12:00:00.000Z",
    completed_at: null,
    output_files: ["pf/report.md"],
    error: null,
    workflow_kind: "deep_research",
    current_phase: "search",
    progress_message: "Searching sources",
    progress: 0.25,
    ...overrides,
  };
}

test.describe("message-store reducer helpers", () => {
  test("creates deterministic optimistic local messages", () => {
    const message = reduceCreateUserMessageEvent({
      type: "create_user_message",
      message: {
        role: "user",
        text: "Hello",
        files: [{ filename: "photo.png", path: "pf/photo.png", caption: "" }],
        toolCalls: [],
        status: "complete",
      },
      createId: () => "local-1",
      now: fixedNow,
    });
    const legacyProjection = createLocalMessage(
      {
        role: "user",
        text: "Hello",
        files: [{ filename: "photo.png", path: "pf/photo.png", caption: "" }],
        toolCalls: [],
        status: "complete",
      },
      () => "local-1",
      fixedNow,
    );

    expect(legacyProjection).toEqual(message);
    expect(message).toMatchObject({
      id: "local-1",
      role: "user",
      text: "Hello",
      status: "complete",
      timestamp: NOW,
      runtime: {
        type: "user",
        status: "completed",
        updatedAt: NOW,
      },
    });
    expect(message.files).toEqual([
      { filename: "photo.png", path: "pf/photo.png", caption: "" },
    ]);
  });

  test("assistant turn lane appends, stops, and ensures streaming messages", () => {
    const streaming = makeMessage({
      id: "assistant-stream",
      role: "assistant",
      text: "",
      status: "streaming",
    });

    const appended = reduceAppendAssistantTextEvent({
      type: "append_assistant_text",
      message: streaming,
      chunk: "Hello",
      now: fixedNow,
    });
    expect(appended.text).toBe("Hello");
    expect(appended.runtime?.status).toBe("ongoing");

    const stopped = reduceStopStreamingAssistantEvent({
      type: "stop_streaming_assistant",
      message: streaming,
      now: fixedNow,
    });
    expect(stopped).toMatchObject({
      text: "Stopped.",
      status: "stopped",
      runtime: { status: "stopped", updatedAt: NOW },
    });

    const filledExisting = reduceEnsureStreamingAssistantEvent({
      type: "ensure_streaming_assistant",
      messages: [streaming],
      text: "Resuming ongoing work...",
      createId: () => "new-assistant",
      now: fixedNow,
    });
    expect(filledExisting.changed).toBe(true);
    expect(filledExisting.messageId).toBe("assistant-stream");
    expect(filledExisting.messages).toHaveLength(1);
    expect(filledExisting.messages[0].text).toBe("Resuming ongoing work...");

    const created = reduceEnsureStreamingAssistantEvent({
      type: "ensure_streaming_assistant",
      messages: [],
      text: "Resuming ongoing work...",
      createId: () => "new-assistant",
      now: fixedNow,
    });
    expect(created).toMatchObject({
      changed: true,
      messageId: "new-assistant",
    });
    expect(created.messages[0]).toMatchObject({
      id: "new-assistant",
      role: "assistant",
      status: "streaming",
      runtime: { status: "ongoing", updatedAt: NOW },
    });
  });

  test("merges authoritative replay into the matching optimistic assistant turn", () => {
    const optimistic = makeMessage({
      id: "optimistic-assistant",
      role: "assistant",
      text: "Resuming ongoing work...",
      status: "streaming",
      timestamp: Date.parse("2026-04-20T12:00:05.000Z"),
      responseToClientMessageId: "client-1",
      files: [{ filename: "local.md", path: "pf/local.md", caption: "local" }],
      meta: {
        model: "mock",
        tokens_in: 1,
        tokens_out: 2,
        duration_s: 3,
      },
    });
    const authoritative = convertApiMessage(
      makeApiMessage({
        seq: 7,
        content: "Final answer",
        response_to_client_message_id: "client-1",
        tool_call_id: "call-final",
        timestamp: "2026-04-20T12:00:08.000Z",
        media: ["pf/final.md"],
      }),
      () => "api-assistant",
      fixedNow,
    );

    expect(authoritative).not.toBeNull();
    expect(findOptimisticMatchIndex([optimistic], authoritative!)).toBe(0);
    const merged = reduceMergeAuthoritativeHistoryMessageEvent({
      type: "merge_authoritative_history_message",
      existing: optimistic,
      authoritative: authoritative!,
      now: fixedNow,
    });

    expect(merged.id).toBe("optimistic-assistant");
    expect(merged.text).toBe("Final answer");
    expect(merged.status).toBe("complete");
    expect(merged.historySeq).toBe(7);
    expect(merged.sourceToolCallId).toBe("call-final");
    expect(merged.meta).toBe(optimistic.meta);
    expect(merged.files.map((file) => file.path)).toEqual([
      "pf/final.md",
      "pf/local.md",
    ]);
    expect(merged.runtime?.status).toBe("completed");
  });

  test("projects task anchors by stable task identity", () => {
    const task = makeTask();
    const anchorMeta = mergeTaskAnchorMeta(undefined, task);
    const anchor = reduceProjectTaskAnchorEvent({
      type: "project_task_anchor",
      sessionId: "session-1",
      task,
      list: [],
      taskAnchor: anchorMeta,
      now: fixedNow,
    });
    const legacyProjection = projectTaskAnchorMessage(
      "session-1",
      task,
      [],
      anchorMeta,
      undefined,
      fixedNow,
    );

    expect(anchor).toEqual(legacyProjection);
    expect(taskIdentity(task)).toBe("task-deep-research");
    expect(taskIdentity({ ...task, id: "   " })).toBeNull();
    expect(anchor).toMatchObject({
      id: "task:session-1:task-deep-research",
      role: "assistant",
      kind: "task_anchor",
      text: "",
      status: "streaming",
      timestamp: Date.parse(task.started_at),
      sourceToolCallId: "call-deep-research",
      runtime: {
        type: "background_task",
        status: "ongoing",
        taskId: "task-deep-research",
        toolCallId: "call-deep-research",
        phase: "search",
        detail: "Searching sources",
      },
    });
    expect(anchor.taskAnchor?.outputFiles).toEqual(["pf/report.md"]);
    expect(sameTaskAnchorMeta(anchor.taskAnchor, anchorMeta)).toBe(true);
    expect(
      findTaskAnchorIndex(
        "session-1",
        new Map([[task.id, anchor.id]]),
        [anchor],
        task,
      ),
    ).toBe(0);
  });

  test("coalesces media-only file results into the preceding assistant answer", () => {
    const answer = makeMessage({
      id: "answer",
      role: "assistant",
      text: "Research report is ready.",
      historySeq: 1,
      timestamp: Date.parse("2026-04-20T12:00:10.000Z"),
    });
    const fileResult = convertApiMessage(
      makeApiMessage({
        seq: 2,
        content: "",
        media: ["pf/research-report.md"],
        timestamp: "2026-04-20T12:00:10.010Z",
      }),
      () => "file-result",
      fixedNow,
    );

    expect(fileResult).not.toBeNull();
    expect(findFileResultTargetIndex(undefined, [answer], fileResult!)).toBe(0);
    const merged = mergeFileResultIntoTarget(answer, fileResult!);

    expect(merged.text).toBe("Research report is ready.");
    expect(merged.historySeq).toBe(2);
    expect(merged.files).toEqual([
      { filename: "research-report.md", path: "pf/research-report.md", caption: "" },
    ]);

    const appended = reduceAppendFileArtifactEvent({
      type: "append_file_artifact",
      message: answer,
      file: { filename: "research-report.md", path: "pf/research-report.md", caption: "" },
    });
    expect(appended.files).toEqual([
      { filename: "research-report.md", path: "pf/research-report.md", caption: "" },
    ]);
    expect(
      reduceAppendFileArtifactEvent({
        type: "append_file_artifact",
        message: appended,
        file: { filename: "research-report.md", path: "pf/research-report.md", caption: "" },
      }),
    ).toBe(appended);
  });

  test("history replay lane converts API messages through a typed event", () => {
    const converted = reduceConvertHistoryReplayMessageEvent({
      type: "convert_history_replay_message",
      message: makeApiMessage({
        seq: 3,
        role: "user",
        content: "From history",
        client_message_id: "client-typed",
        timestamp: "2026-04-20T12:00:15.000Z",
      }),
      createId: () => "history-user",
      now: fixedNow,
    });

    expect(converted).toMatchObject({
      id: "history-user",
      role: "user",
      text: "From history",
      clientMessageId: "client-typed",
      historySeq: 3,
      runtime: {
        type: "user",
        status: "completed",
        updatedAt: NOW,
      },
    });
  });

  test("matches output files by path aliases without prompt text heuristics", () => {
    const anchor = makeMessage({
      id: "task-anchor",
      role: "assistant",
      kind: "task_anchor",
      taskAnchor: { taskId: "task-1", outputFiles: ["pf/research-report.md"] },
    });
    const outputMap = new Map(
      pathMatchKeys("pf/research-report.md").map((key) => [key, anchor.id]),
    );

    expect(
      findMessageIndexForFilePath(outputMap, [anchor], {
        filename: "research-report.md",
        path: "research-report.md",
        caption: "",
      }),
    ).toBe(0);
  });

  test("identifies assistant file companions and merges duplicate payloads", () => {
    const primary = makeMessage({
      id: "assistant-text",
      role: "assistant",
      text: "Same report text",
      historySeq: 1,
      timestamp: Date.parse("2026-04-20T12:00:00.000Z"),
    });
    const duplicate = makeMessage({
      id: "assistant-file",
      role: "assistant",
      text: "Same report text",
      files: [{ filename: "report.md", path: "pf/report.md", caption: "" }],
      historySeq: 2,
      timestamp: Date.parse("2026-04-20T12:00:03.000Z"),
    });

    expect(isAssistantCompanionForFileMessage(primary, duplicate)).toBe(true);
    expect(shouldCollapseAuthoritativeDuplicate(primary, primary)).toBe(true);

    const merged = mergeAssistantDuplicate(primary, duplicate);
    expect(merged.id).toBe("assistant-text");
    expect(merged.text).toBe("Same report text");
    expect(merged.historySeq).toBe(2);
    expect(merged.files).toEqual(duplicate.files);
  });

  test("characterizes current task-anchor and pending display ordering", () => {
    const user = makeMessage({
      id: "user",
      role: "user",
      text: "Start research",
      historySeq: 0,
      timestamp: Date.parse("2026-04-20T12:00:00.000Z"),
    });
    const assistant = makeMessage({
      id: "assistant",
      role: "assistant",
      text: "Research started.",
      historySeq: 1,
      timestamp: Date.parse("2026-04-20T12:00:05.000Z"),
    });
    const taskAnchor = makeMessage({
      id: "task",
      role: "assistant",
      kind: "task_anchor",
      timestamp: Date.parse("2026-04-20T12:00:02.000Z"),
      taskAnchor: { taskId: "task-1" },
    });
    const pending = makeMessage({
      id: "pending",
      role: "assistant",
      text: "Pending local stream",
      timestamp: Date.parse("2026-04-20T11:59:59.000Z"),
    });

    // Timestamp-primary comparator: pure chronological order across all kinds
    // (task anchors, pending no-seq, server-stamped). pending=11:59:59 first,
    // user=12:00:00, task=12:00:02, assistant=12:00:05.
    expect(
      sortedMessagesForDisplay([assistant, pending, taskAnchor, user]).map(
        (message) => message.id,
      ),
    ).toEqual(["pending", "user", "task", "assistant"]);
  });

  test("task anchor sorts after user prompt when server started_at predates client timestamp", () => {
    // Bug 1: clock skew between browser and server can place task.started_at
    // BEFORE the user message timestamp, causing the "Deep research in
    // progress" anchor to render ABOVE the user prompt that triggered it.
    const userTs = Date.parse("2026-04-20T12:00:00.000Z");
    const user = makeMessage({ id: "user", role: "user", timestamp: userTs });
    const task = makeTask({ id: "skew", started_at: "2026-04-20T11:59:58.000Z" });
    const anchor = projectTaskAnchorMessage(
      "sess", task, [user], mergeTaskAnchorMeta(undefined, task), undefined, fixedNow,
    );
    expect(anchor.timestamp).toBeGreaterThan(user.timestamp);
    expect(sortedMessagesForDisplay([anchor, user]).map((m) => m.id)).toEqual([
      user.id, anchor.id,
    ]);

    // Same projector keeps the server timestamp when the task starts AFTER
    // the prompt (no skew).
    const later = makeTask({ id: "later", started_at: "2026-04-20T12:00:03.000Z" });
    const laterAnchor = projectTaskAnchorMessage(
      "sess", later, [user], mergeTaskAnchorMeta(undefined, later), undefined, fixedNow,
    );
    expect(laterAnchor.timestamp).toBe(Date.parse(later.started_at));
  });

  test("findNoSeqDuplicateIndex covers role/window/seq guards for no-seq messages", () => {
    // Bug 2: messages without historySeq bypass both the seq guard and the
    // confirmed-text guard, so they append on every poll. The no-seq guard
    // matches by role + normalized text + a short timestamp window.
    const baseTs = Date.parse("2026-04-20T12:00:00.000Z");
    const savedText = "已记住。Saratoga, CA 今天多云，11.6°C，湿度 80%，几乎无风";
    const existing = makeMessage({ id: "a", role: "assistant", text: savedText, timestamp: baseTs });

    // 1) Same role + same text within window → dedup.
    expect(
      findNoSeqDuplicateIndex([existing], makeMessage({
        id: "dup", role: "assistant", text: savedText, timestamp: baseTs + 3_000,
      })),
    ).toBe(0);

    // 2) Same role + same text but outside the 10s window → keep both.
    expect(
      findNoSeqDuplicateIndex([existing], makeMessage({
        id: "stale", role: "assistant", text: savedText, timestamp: baseTs + 60_000,
      })),
    ).toBe(-1);

    // 3) Different role → keep both (user echoing the same text).
    expect(
      findNoSeqDuplicateIndex([existing], makeMessage({
        id: "user", role: "user", text: savedText, timestamp: baseTs + 1_000,
      })),
    ).toBe(-1);

    // 4) Converted has a historySeq → let the seq-based guard handle it.
    expect(
      findNoSeqDuplicateIndex([existing], makeMessage({
        id: "with-seq", role: "assistant", text: savedText, timestamp: baseTs + 2_000,
        historySeq: 5,
      })),
    ).toBe(-1);
  });

  // ── M8.10-A: SSE `done` event populates historySeq on live bubbles ──

  test("finalize_assistant_sets_history_seq_when_provided", () => {
    // M8.10-A regression: when the SSE `done` event carries `committed_seq`,
    // applyFinalizeAssistant must write it onto the matching bubble so the
    // sort comparator sees a real seq instead of MAX_SAFE_INTEGER.
    const sessionId = `m810a-set-${Date.now()}`;
    const messageId = MessageStore.addMessage(sessionId, {
      role: "assistant",
      text: "",
      files: [],
      toolCalls: [],
      status: "streaming",
    });

    applyFinalizeAssistant({
      type: "finalize_assistant",
      sessionId,
      messageId,
      text: "Hello!",
      historySeq: 5,
    });

    const messages = MessageStore.getMessages(sessionId);
    const finalized = messages.find((m) => m.id === messageId);
    expect(finalized).toBeDefined();
    expect(finalized?.text).toBe("Hello!");
    expect(finalized?.status).toBe("complete");
    expect(finalized?.historySeq).toBe(5);
  });

  test("finalize_assistant_leaves_history_seq_undefined_when_missing_from_done", () => {
    // M8.10-A: when an old/legacy server omits `committed_seq` from the `done`
    // event, the finalize action must NOT fabricate or default the seq —
    // leaving historySeq undefined keeps the bubble on the timestamp-only
    // sort path used by older builds.
    const sessionId = `m810a-missing-${Date.now()}`;
    const messageId = MessageStore.addMessage(sessionId, {
      role: "assistant",
      text: "",
      files: [],
      toolCalls: [],
      status: "streaming",
    });

    applyFinalizeAssistant({
      type: "finalize_assistant",
      sessionId,
      messageId,
      text: "Legacy response",
    });

    const messages = MessageStore.getMessages(sessionId);
    const finalized = messages.find((m) => m.id === messageId);
    expect(finalized).toBeDefined();
    expect(finalized?.text).toBe("Legacy response");
    expect(finalized?.status).toBe("complete");
    expect(finalized?.historySeq).toBeUndefined();
  });

  test("done_event_with_committed_seq_keeps_bubble_in_chronological_order", () => {
    // M8.10-A integration: simulate the full SSE-stream → done sequence on
    // the message-store side. Bubble starts streaming (no historySeq),
    // applyFinalizeAssistant receives committed_seq=5 from the `done` event,
    // and a subsequent message with historySeq=6 arrives. The live bubble
    // must NOT migrate to the end of the list when sorted for display.
    const sessionId = `m810a-flow-${Date.now()}`;

    // 1. SSE stream starts — placeholder bubble created (no historySeq yet).
    const assistantMsgId = MessageStore.addMessage(sessionId, {
      role: "assistant",
      text: "",
      files: [],
      toolCalls: [],
      status: "streaming",
    });

    // 2. Token events come in (omitted here — irrelevant to seq logic).
    //    Pretend the final text is accumulated.

    // 3. SSE `done` event arrives with committed_seq=5.
    applyFinalizeAssistant({
      type: "finalize_assistant",
      sessionId,
      messageId: assistantMsgId,
      text: "Live response",
      historySeq: 5,
    });

    // 4. Newer message lands with historySeq=6.
    const followUpId = MessageStore.addMessage(sessionId, {
      role: "user",
      text: "Follow-up",
      files: [],
      toolCalls: [],
      status: "complete",
    });
    MessageStore.setMessageHistorySeq(sessionId, followUpId, 6);

    // 5. Sort — assistant bubble must come BEFORE the seq=6 follow-up.
    const messages = MessageStore.getMessages(sessionId);
    const sorted = sortedMessagesForDisplay(messages);
    const assistantIdx = sorted.findIndex((m) => m.id === assistantMsgId);
    const followUpIdx = sorted.findIndex((m) => m.id === followUpId);
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(followUpIdx).toBeGreaterThan(assistantIdx);

    // Sanity: the live bubble actually got the seq written.
    const finalBubble = sorted[assistantIdx];
    expect(finalBubble.historySeq).toBe(5);
  });

  test("done_event_without_committed_seq_keeps_bubble_renderable_via_timestamp", () => {
    // M8.10-A backward-compat: legacy server omits `committed_seq` from the
    // `done` event. The bubble's historySeq stays undefined, but it still
    // renders correctly via timestamp ordering against other no-seq messages.
    const sessionId = `m810a-legacy-${Date.now()}`;

    const earlierId = MessageStore.addMessage(sessionId, {
      role: "user",
      text: "Earlier prompt",
      files: [],
      toolCalls: [],
      status: "complete",
    });
    // Force a known timestamp ordering by waiting one millisecond.
    const assistantId = MessageStore.addMessage(sessionId, {
      role: "assistant",
      text: "",
      files: [],
      toolCalls: [],
      status: "streaming",
    });

    // Legacy `done` event — no committed_seq.
    applyFinalizeAssistant({
      type: "finalize_assistant",
      sessionId,
      messageId: assistantId,
      text: "Legacy reply",
    });

    const messages = MessageStore.getMessages(sessionId);
    const sorted = sortedMessagesForDisplay(messages);
    const earlierIdx = sorted.findIndex((m) => m.id === earlierId);
    const assistantIdx = sorted.findIndex((m) => m.id === assistantId);
    expect(earlierIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThan(earlierIdx);
    expect(sorted[assistantIdx].historySeq).toBeUndefined();
    expect(sorted[assistantIdx].text).toBe("Legacy reply");
    expect(sorted[assistantIdx].status).toBe("complete");
  });

  test("sorted_display_orders_by_timestamp_regardless_of_history_seq_presence", () => {
    // Timestamp-primary comparator: chronological order is determined by
    // `timestamp`, so a no-seq live bubble slots between earlier and later
    // seq'd messages by its own timestamp without waiting on a server seq.
    // (Pre-fix this bubble sorted to the END via MAX_SAFE_INTEGER fallback.)
    const userTs = Date.parse("2026-04-20T12:00:00.000Z");
    const assistantStreamTs = Date.parse("2026-04-20T12:00:05.000Z");
    const followUpTs = Date.parse("2026-04-20T12:00:10.000Z");

    const userMessage = makeMessage({
      id: "user-1",
      role: "user",
      text: "Hi",
      timestamp: userTs,
      historySeq: 0,
    });

    const noSeqLiveBubble = makeMessage({
      id: "assistant-1",
      role: "assistant",
      text: "Live reply",
      timestamp: assistantStreamTs,
      // No historySeq — streaming bubble before any seq lands.
    });

    const followUp = makeMessage({
      id: "user-2",
      role: "user",
      text: "Follow up",
      timestamp: followUpTs,
      historySeq: 6,
    });

    // No seq on the live bubble: timestamp ordering still places it correctly.
    expect(
      sortedMessagesForDisplay([userMessage, noSeqLiveBubble, followUp]).map(
        (m) => m.id,
      ),
    ).toEqual(["user-1", "assistant-1", "user-2"]);

    // With seq populated: same chronological order, seq is just a tiebreaker
    // for same-timestamp peers (rare).
    const withSeq: Message = { ...noSeqLiveBubble, historySeq: 5 };
    expect(
      sortedMessagesForDisplay([userMessage, withSeq, followUp]).map((m) => m.id),
    ).toEqual(["user-1", "assistant-1", "user-2"]);
  });
});
