import { afterEach, describe, expect, it } from "vitest";
import * as ThreadStore from "./thread-store";

const sessionId = "session-thread-store";
const threadId = "cmid-thread-store";

afterEach(() => {
  ThreadStore.__resetForTests();
});

describe("thread-store compatibility bookkeeping", () => {
  it("keeps tool progress attached to its originating compatibility event", () => {
    ThreadStore.addUserMessage(sessionId, {
      text: "run the tool",
      clientMessageId: threadId,
    });
    ThreadStore.addToolCall(threadId, "tool-1", "shell", { command: "pwd" });
    ThreadStore.appendToolProgress(threadId, "tool-1", "running");
    expect(ThreadStore.setToolCallStatus(threadId, "tool-1", "complete")).toBe(true);

    const [thread] = ThreadStore.getThreads(sessionId);
    expect(thread.pendingAssistant?.toolCalls).toEqual([
      expect.objectContaining({
        id: "tool-1",
        name: "shell",
        status: "complete",
        progress: [expect.objectContaining({ message: "running" })],
      }),
    ]);
  });
});

describe("spawn_complete double-render dedupe", () => {
  it("does not append a second bubble when the reply already streamed live", () => {
    // The reply streams via message/delta onto the pending bubble (which has
    // the turn's own id, NOT the completion envelope's messageId/historySeq),
    // then turn/spawn_complete arrives carrying the SAME full text. The
    // content-identity guard must recognize the duplicate and NOT append a
    // second bubble.
    ThreadStore.addUserMessage(sessionId, {
      text: "do a thing",
      clientMessageId: threadId,
    });
    const fullText = "Here is the complete answer.";
    // Simulate live streaming landing the full text on the pending bubble.
    ThreadStore.appendAssistantToken(threadId, fullText);

    // spawn_complete arrives with the same text but a different messageId/seq.
    const appended = ThreadStore.appendCompletionBubble(threadId, {
      text: fullText,
      media: [],
      spawnComplete: true,
      messageId: "completion-msg-1",
      historySeq: 42,
      sessionId,
    });
    expect(appended).toBe(true); // handled (deduped), not an error

    const [thread] = ThreadStore.getThreads(sessionId);
    const assistantTexts = [
      ...(thread.pendingAssistant ? [thread.pendingAssistant.text] : []),
      ...thread.responses.filter((r) => r.role === "assistant").map((r) => r.text),
    ].filter((t) => t === fullText);
    expect(assistantTexts).toHaveLength(1);
  });

  it("still appends when content differs (genuine new completion)", () => {
    ThreadStore.addUserMessage(sessionId, {
      text: "do a thing",
      clientMessageId: threadId,
    });
    ThreadStore.appendAssistantToken(threadId, "streamed text");
    ThreadStore.appendCompletionBubble(threadId, {
      text: "a DIFFERENT completion",
      media: [],
      spawnComplete: true,
      messageId: "completion-msg-2",
      historySeq: 43,
      sessionId,
    });

    const [thread] = ThreadStore.getThreads(sessionId);
    const assistantRows = thread.responses.filter((r) => r.role === "assistant");
    expect(assistantRows.map((r) => r.text)).toContain("a DIFFERENT completion");
  });

  it("dedupes when the two lanes differ only in trailing whitespace", () => {
    // Byte-equality is too strict for the real wire. Streaming appends raw
    // deltas; the completion carries the server's joined-and-persisted copy,
    // and the two routinely disagree by a newline at the seam. Measured on an
    // octos ui-protocol ledger: 3738 streamed chars vs 3735 persisted for the
    // identical answer. Under `===` this turn renders TWICE.
    ThreadStore.addUserMessage(sessionId, {
      text: "do a thing",
      clientMessageId: threadId,
    });
    const streamed = "Here is the complete answer.";
    ThreadStore.appendAssistantToken(threadId, streamed);

    ThreadStore.appendCompletionBubble(threadId, {
      text: `${streamed}\n`,
      media: [],
      spawnComplete: true,
      messageId: "completion-msg-3",
      historySeq: 44,
      sessionId,
    });

    const [thread] = ThreadStore.getThreads(sessionId);
    const assistantTexts = [
      ...(thread.pendingAssistant ? [thread.pendingAssistant.text] : []),
      ...thread.responses
        .filter((r) => r.role === "assistant")
        .map((r) => r.text),
    ].filter((t) => t.trim() === streamed);
    expect(assistantTexts).toHaveLength(1);
  });

  it("still commits the reply after the completion was deduped", () => {
    // The dedupe path returns BEFORE appending, so the answer exists only on
    // `pendingAssistant` until `turn/completed` promotes it. If a future
    // refactor makes the dedupe also swallow that promotion, the reply
    // disappears and the session wedges — which is exactly what octos-tui's
    // #379 cross-lane dedupe did (it now carries the mirror-image guard,
    // `legacy_terminal_still_commits_after_v2_persisted_rows`). Pin it here.
    ThreadStore.addUserMessage(sessionId, {
      text: "do a thing",
      clientMessageId: threadId,
    });
    const fullText = "Here is the complete answer.";
    ThreadStore.appendAssistantToken(threadId, fullText);
    ThreadStore.appendCompletionBubble(threadId, {
      text: fullText,
      media: [],
      spawnComplete: true,
      messageId: "completion-msg-4",
      historySeq: 45,
      sessionId,
    });

    ThreadStore.finalizeAssistant(threadId);

    const [thread] = ThreadStore.getThreads(sessionId);
    expect(thread.pendingAssistant).toBeNull();
    const assistantRows = thread.responses.filter((r) => r.role === "assistant");
    expect(assistantRows.map((r) => r.text)).toEqual([fullText]);
  });
});
