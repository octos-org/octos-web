import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as ProjectionStore from "./projection-store";
import * as TaskStore from "./task-store";
import * as ThreadStore from "./thread-store";

const ADMIN_SESSION = "web-admin-session";

beforeEach(() => {
  ProjectionStore.__resetProjectionForTests();
  ProjectionStore.__setProjectionV1ForTests(true);
  ThreadStore.__resetForTests();
  TaskStore.clearTasks(ADMIN_SESSION);
});

afterEach(() => {
  ThreadStore.__resetForTests();
  TaskStore.clearTasks(ADMIN_SESSION);
  ProjectionStore.__resetProjectionForTests();
});

describe("identity-bound in-memory stores", () => {
  it("clears session and task data when the authentication token clears", () => {
    ThreadStore.addUserMessage(ADMIN_SESSION, {
      text: "administrator-only conversation",
      clientMessageId: "admin-message",
    });
    ThreadStore.appendAssistantToken("admin-message", "private response");
    TaskStore.replaceTasks(ADMIN_SESSION, [
      {
        id: "admin-task",
        tool_name: "deep_search",
        status: "running",
        started_at: new Date(2026, 0, 1).toISOString(),
        completed_at: null,
        output_files: [],
        error: null,
      },
    ]);

    expect(ThreadStore.getThreads(ADMIN_SESSION)).toHaveLength(1);
    expect(TaskStore.getTasks(ADMIN_SESSION)).toHaveLength(1);
    expect(ProjectionStore.getEnvelopes(ADMIN_SESSION).length).toBeGreaterThan(0);

    window.dispatchEvent(new CustomEvent("crew:token_cleared"));

    expect(ThreadStore.getThreads(ADMIN_SESSION)).toEqual([]);
    expect(TaskStore.getTasks(ADMIN_SESSION)).toEqual([]);
    expect(ProjectionStore.getEnvelopes(ADMIN_SESSION)).toEqual([]);
  });
});
