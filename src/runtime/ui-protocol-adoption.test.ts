/**
 * UI Protocol adoption guard for the production web chat surface.
 *
 * Issue octos-org/octos#573 is an incremental migration contract: chat
 * turns, session/task state, approvals, task output, and future diff review
 * hooks should stay on UI Protocol v1. This source-level guard complements
 * the protocol bridge/unit fixtures by failing if the production web chat
 * surfaces reintroduce the retired `/api/chat` REST/SSE dependency.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function expectNoLegacyChatTransport(path: string): void {
  const text = source(path);
  expect(text, `${path} must not construct legacy /api/chat fetches`).not.toMatch(
    /\bfetch\s*\(\s*[^)]*["'`][^"'`]*(?:\/api\/chat|\/chat\?)/,
  );
  expect(text, `${path} must not construct legacy /api/chat EventSource`).not.toMatch(
    /\bEventSource\s*\(\s*[^)]*["'`][^"'`]*(?:\/api\/chat|\/chat\?)/,
  );
}

describe("UI Protocol v1 production adoption", () => {
  it("keeps chat send surfaces on the WS turn/start bridge", () => {
    for (const path of [
      "src/components/chat-thread.tsx",
      "src/slides/components/slides-chat.tsx",
      "src/sites/components/sites-chat.tsx",
      "src/runtime/ui-protocol-send.ts",
    ]) {
      expectNoLegacyChatTransport(path);
    }

    expect(source("src/components/chat-thread.tsx")).toContain(
      'sendMessage as bridgeSend',
    );
    expect(source("src/slides/components/slides-chat.tsx")).toContain(
      'sendMessage as bridgeSend',
    );
    expect(source("src/sites/components/sites-chat.tsx")).toContain(
      'sendMessage as bridgeSend',
    );
    expect(source("src/runtime/ui-protocol-send.ts")).toContain(
      "bridge.sendTurn",
    );
  });

  it("keeps session and task state on UI Protocol wrapper methods", () => {
    const sessions = source("src/api/sessions.ts");
    for (const method of [
      "SESSION_LIST",
      "SESSION_MESSAGES_PAGE",
      "SESSION_STATUS_GET",
      "SESSION_TASKS_LIST",
      "SESSION_SNAPSHOT",
      "SESSION_TITLE_SET",
    ]) {
      expect(sessions).toContain(`METHODS.${method}`);
    }
    expect(sessions).toContain("callAuxWs");
    expectNoLegacyChatTransport("src/api/sessions.ts");

    const watcher = source("src/runtime/task-watcher.ts");
    expect(watcher).toContain("getSessionTasks");
    expect(watcher).toContain("TaskStore.replaceTasks");
    expectNoLegacyChatTransport("src/runtime/task-watcher.ts");
  });

  it("keeps approval, task-output, committed-result, and diff hooks in the bridge contract", () => {
    const bridge = source("src/runtime/ui-protocol-bridge.ts");
    for (const methodOrEvent of [
      'APPROVAL_REQUESTED: "approval/requested"',
      'APPROVAL_RESPOND: "approval/respond"',
      'TASK_OUTPUT_DELTA: "task/output/delta"',
      'TASK_UPDATED: "task/updated"',
      'MESSAGE_PERSISTED: "message/persisted"',
      'DIFF_PREVIEW_GET: "diff/preview/get"',
    ]) {
      expect(bridge).toContain(methodOrEvent);
    }
  });
});
