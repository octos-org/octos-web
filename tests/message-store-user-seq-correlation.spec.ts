/**
 * Verifies the optimistic user bubble's `historySeq` gets stamped from the
 * server-assigned sequence when a `session_result` event arrives correlated
 * by `client_message_id`.
 *
 * Before this fix: M8.10-A closed the `done`-event seq gap that previously
 * triggered a `fetchSessionMessages` backfill — and that backfill was the
 * only path that adopted user-message seqs as a side effect. Optimistic
 * user bubbles therefore never received a `historySeq`, sorted to
 * `MAX_SAFE_INTEGER`, and produced live UI flicker plus out-of-order
 * spawn_only completion bubbles.
 *
 * After this fix: the server emits a `session_result` event for each
 * persisted user message containing role: "user", the committed seq, and
 * the client-supplied id. The web bridge calls
 * `setMessageHistorySeqByClientMessageId` to find the optimistic bubble
 * and stamp the seq onto it directly, no backfill needed.
 */

import { expect, test } from "@playwright/test";
import {
  addMessage,
  getMessages,
  setMessageHistorySeqByClientMessageId,
} from "../src/store/message-store";

const SESSION_ID = "unit-user-seq-correlation";

test.describe("applies_history_seq_to_optimistic_user_bubble_on_session_result_user_event", () => {
  test("stamps historySeq on the user bubble matched by client_message_id", () => {
    // Mirror what `sendMessage` does: write an optimistic user bubble with
    // a UUID before the SSE stream returns.
    const bubbleId = addMessage(
      SESSION_ID,
      {
        role: "user",
        text: "remind me about lunch",
        clientMessageId: "cmid-correlation-1",
        files: [],
        toolCalls: [],
        status: "complete",
      },
    );

    // No historySeq yet — that's the regression's starting state.
    expect(getMessages(SESSION_ID).find((m) => m.id === bubbleId)?.historySeq).toBeUndefined();

    const updated = setMessageHistorySeqByClientMessageId(
      SESSION_ID,
      "cmid-correlation-1",
      4,
    );

    expect(updated).toBe(true);
    const after = getMessages(SESSION_ID).find((m) => m.id === bubbleId);
    expect(after?.historySeq).toBe(4);
  });

  test("returns false when no optimistic bubble matches (legacy / resumed sessions)", () => {
    const isolated = `${SESSION_ID}-no-match`;
    addMessage(
      isolated,
      {
        role: "user",
        text: "earlier",
        clientMessageId: "cmid-existing",
        files: [],
        toolCalls: [],
        status: "complete",
      },
    );

    const updated = setMessageHistorySeqByClientMessageId(
      isolated,
      "cmid-not-present",
      9,
    );

    expect(updated).toBe(false);
  });

  test("does not mistakenly stamp seq onto an assistant bubble that responded to the same id", () => {
    const isolated = `${SESSION_ID}-role-guard`;
    addMessage(
      isolated,
      {
        role: "user",
        text: "user msg",
        clientMessageId: "cmid-shared",
        files: [],
        toolCalls: [],
        status: "complete",
      },
    );
    // The assistant bubble carries `responseToClientMessageId === cmid-shared`
    // by convention. The function must only update bubbles whose
    // `clientMessageId` (not `responseToClientMessageId`) matches.
    const assistantId = addMessage(
      isolated,
      {
        role: "assistant",
        text: "reply",
        responseToClientMessageId: "cmid-shared",
        files: [],
        toolCalls: [],
        status: "complete",
      },
    );

    const updated = setMessageHistorySeqByClientMessageId(
      isolated,
      "cmid-shared",
      11,
    );

    expect(updated).toBe(true);
    const list = getMessages(isolated);
    const userMsg = list.find((m) => m.role === "user");
    const assistantMsg = list.find((m) => m.id === assistantId);
    expect(userMsg?.historySeq).toBe(11);
    // Assistant must NOT have the stamp — it never matched on
    // `clientMessageId`.
    expect(assistantMsg?.historySeq).toBeUndefined();
  });
});
