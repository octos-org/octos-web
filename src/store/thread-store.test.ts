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
