/**
 * session-context tests — Bug A (M10 follow-up).
 *
 * The sidebar dropped newly-created chats once a user accumulated more than
 * ~20 prior sessions: `refreshSessions` capped the API list with
 * `.slice(0, 20)` *before* merging, so a brand-new session at the top of the
 * list pushed an old one out — which would have been fine, except `_local`
 * was cleared by the first successful merge, so on a later refresh (when
 * clock-skewed concurrent activity bumped the new session out of the top
 * 20) it vanished entirely. Deleting any visible session "revealed
 * previously hidden ones" because the slice window then had room.
 *
 * These tests cover the pure {@link mergeSessionLists} helper.
 */

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getMessages: vi.fn(),
  getMessagesPage: vi.fn(),
  getSessionTasks: vi.fn(),
  deleteSession: vi.fn(),
  setSessionTitle: vi.fn(),
}));

vi.mock("@/api/sessions", () => ({
  listSessions: apiMocks.listSessions,
  getMessages: apiMocks.getMessages,
  getMessagesPage: apiMocks.getMessagesPage,
  getSessionTasks: apiMocks.getSessionTasks,
  deleteSession: apiMocks.deleteSession,
  setSessionTitle: apiMocks.setSessionTitle,
}));

import {
  applyOptimisticRename,
  mergeSessionLists,
  rollbackOptimisticRename,
  sessionTimestamp,
  SessionProvider,
  SESSION_LIST_RENDER_CAP,
  useSession,
  type SessionContextValue,
  type SessionWithTitle,
} from "./session-context";
import { SessionList } from "@/components/session-list";
import * as TaskStore from "@/store/task-store";
import type { BackgroundTaskInfo, SessionInfo } from "@/api/types";

const NO_TITLES: Record<string, string> = {};
const NO_DELETES = new Set<string>();
const SESSION_TITLES_KEY = "octos_session_titles";

// `sessionTimestamp` rejects ms timestamps < 1700000000000 (~Nov 2023) so
// fixtures need a realistic base.
const TS_BASE = 1_777_700_000_000;

function webSession(
  offsetMs: number,
  msgs = 2,
  suffix = "abc",
): SessionInfo {
  return { id: `web-${TS_BASE + offsetMs}-${suffix}`, message_count: msgs };
}

function idAt(offsetMs: number, suffix = "abc"): string {
  return `web-${TS_BASE + offsetMs}-${suffix}`;
}

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function CaptureSessionContext({
  onValue,
}: {
  onValue: (ctx: SessionContextValue) => void;
}) {
  onValue(useSession());
  return null;
}

function mountSessionProvider(
  onValue: (ctx: SessionContextValue) => void,
): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        SessionProvider,
        null,
        React.createElement(CaptureSessionContext, { onValue }),
      ),
    );
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function mountSessionList(): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        SessionProvider,
        null,
        React.createElement(SessionList),
      ),
    );
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function backgroundTask(id: string): BackgroundTaskInfo {
  return {
    id,
    tool_name: "spawn_agent",
    status: "running",
    started_at: "2026-05-30T00:00:00.000Z",
    error: null,
  };
}

async function flushReactWork(cycles = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < cycles; i += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  apiMocks.listSessions.mockResolvedValue([]);
  apiMocks.getMessages.mockResolvedValue([]);
  apiMocks.getMessagesPage.mockResolvedValue({
    messages: [],
    has_more: false,
    next_offset: null,
  });
  apiMocks.getSessionTasks.mockResolvedValue([]);
  apiMocks.deleteSession.mockResolvedValue(undefined);
  apiMocks.setSessionTitle.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const node of [...document.body.children]) node.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("sessionTimestamp", () => {
  it("parses web-{ms}-{rand} format", () => {
    expect(
      sessionTimestamp({ id: "web-1777707464648-i3tb33", message_count: 1 }),
    ).toBe(1777707464648);
  });

  it("returns 0 for non-numeric prefixes", () => {
    expect(
      sessionTimestamp({ id: "web-codex-probe-1", message_count: 1 }),
    ).toBe(0);
  });

  it("returns 0 for sub-threshold (pre-2023) timestamps", () => {
    // Anything below 1700000000000 (~Nov 2023) is treated as bogus to keep
    // legacy/test artifacts from sorting above real sessions.
    expect(sessionTimestamp({ id: "web-1000-abc", message_count: 1 })).toBe(0);
  });
});

describe("mergeSessionLists", () => {
  it("returns all eligible sessions sorted newest-first", () => {
    const list: SessionInfo[] = [
      webSession(1000),
      webSession(3000),
      webSession(2000),
    ];
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([
      idAt(3000),
      idAt(2000),
      idAt(1000),
    ]);
  });

  it("filters out non-web sessions", () => {
    const list: SessionInfo[] = [
      webSession(1000),
      { id: "test-foo", message_count: 5 },
      { id: "smoke-bar", message_count: 5 },
    ];
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([idAt(1000)]);
  });

  it("filters out sessions with no persisted messages", () => {
    const list: SessionInfo[] = [
      webSession(1000, 0),
      webSession(2000, 1),
      webSession(3000, 0),
    ];
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([idAt(2000)]);
  });

  it("filters out tombstoned sessions", () => {
    const list: SessionInfo[] = [webSession(1000), webSession(2000)];
    const deleted = new Set([idAt(2000)]);
    const merged = mergeSessionLists([], list, deleted, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([idAt(1000)]);
  });

  it("hydrates titles from cache by id", () => {
    const list: SessionInfo[] = [webSession(1000)];
    const titles = { [idAt(1000)]: "first chat" };
    const merged = mergeSessionLists([], list, NO_DELETES, titles);
    expect(merged[0].title).toBe("first chat");
  });

  it("preserves local-only sessions not yet visible in the API list", () => {
    // Brand-new chat: createSession bumped `currentSessionId`, the user sent
    // their first message, `markSessionActive` marked it `_local: true`, but
    // the very next `refreshSessions` runs before the server has indexed it.
    const local: SessionWithTitle = {
      id: idAt(9999, "fresh"),
      message_count: 1,
      _local: true,
      title: "draft",
    };
    const list: SessionInfo[] = [webSession(1000), webSession(2000)];
    const merged = mergeSessionLists([local], list, NO_DELETES, NO_TITLES);
    expect(merged.map((s) => s.id)).toEqual([
      idAt(9999, "fresh"),
      idAt(2000),
      idAt(1000),
    ]);
  });

  it("drops local-only sessions once the API echoes them", () => {
    const local: SessionWithTitle = {
      id: idAt(2000),
      message_count: 1,
      _local: true,
      title: "draft",
    };
    const list: SessionInfo[] = [webSession(2000, 4)];
    const titles = { [idAt(2000)]: "from server" };
    const merged = mergeSessionLists([local], list, NO_DELETES, titles);
    // Single entry, server-canonical (no `_local`, has the API message_count
    // and the cached title).
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(idAt(2000));
    expect(merged[0]._local).toBeUndefined();
    expect(merged[0].message_count).toBe(4);
    expect(merged[0].title).toBe("from server");
  });

  it("renders well over the legacy 20-session cap (Bug A regression guard)", () => {
    // Build 50 sessions — the previous slice(0, 20) hard-capped here.
    const list: SessionInfo[] = Array.from({ length: 50 }, (_, i) =>
      webSession(i, 2, `s${i}`),
    );
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged).toHaveLength(50);
    // Newest first.
    expect(merged[0].id).toBe(idAt(49, "s49"));
    expect(merged[49].id).toBe(idAt(0, "s0"));
  });

  it("respects the soft render cap for pathological session counts", () => {
    const cap = SESSION_LIST_RENDER_CAP;
    const total = cap + 25;
    const list: SessionInfo[] = Array.from({ length: total }, (_, i) =>
      webSession(i, 2, `s${i}`),
    );
    const merged = mergeSessionLists([], list, NO_DELETES, NO_TITLES);
    expect(merged).toHaveLength(cap);
    // The cap drops the OLDEST entries, not the newest — so the most recent
    // session is still present.
    expect(merged[0].id).toBe(idAt(total - 1, `s${total - 1}`));
  });

  it("regression: freshly-sent chat survives a follow-up refresh even when many other sessions exist", () => {
    // Simulate the user's reported flow under the old code:
    //   1. User has 25 prior sessions visible on the sidebar.
    //   2. User creates session #26 and sends a message.
    //   3. After `markSessionActive`, prev contains the new session as
    //      `_local: true`.
    //   4. `refreshSessions` runs: API returns all 26 sessions including
    //      the newest. Under the old slice(0, 20) the newest was kept, but
    //      `_local` was stripped on merge — fine for this refresh.
    //   5. Some concurrent activity (or just clock skew) means there are
    //      now 30+ sessions ahead of the user's chat in the sorted list.
    //   6. Under the old slice(0, 20), our new session would sit at
    //      position 21+ and be sliced out, vanishing from the sidebar
    //      entirely. Deleting any visible session would reveal the
    //      previously-hidden one — exactly the user's symptom.
    //
    // After the fix the cap is large enough that this no longer happens.
    const others = Array.from({ length: 30 }, (_, i) =>
      webSession(1_000 + i, 4, `o${i}`),
    );
    const userNew: SessionInfo = {
      id: idAt(500, "mine"),
      message_count: 2,
    };
    const list = [...others, userNew];

    // After step 4, `_local` was already stripped from prev.
    const prev: SessionWithTitle[] = [
      { ...userNew, title: "my chat" },
      ...others.map((s) => ({ ...s })),
    ];

    const merged = mergeSessionLists(prev, list, NO_DELETES, {
      [idAt(500, "mine")]: "my chat",
    });
    const ids = merged.map((s) => s.id);
    expect(ids).toContain(idAt(500, "mine"));
    expect(merged).toHaveLength(31);
  });
});

describe("SessionProvider title integration", () => {
  it("rolls back renameSession through the actual provider callback when setSessionTitle rejects", async () => {
    const sessionId = idAt(42, "rename");
    apiMocks.listSessions.mockResolvedValue([
      { id: sessionId, message_count: 3, title: "old title" },
    ] satisfies SessionInfo[]);
    apiMocks.setSessionTitle.mockRejectedValueOnce(
      new Error("forbidden: invalid title"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let latest: SessionContextValue | null = null;
    const harness = mountSessionProvider((ctx) => {
      latest = ctx;
    });
    try {
      await flushReactWork();
      expect(latest?.sessions.find((s) => s.id === sessionId)?.title).toBe(
        "old title",
      );

      act(() => {
        latest?.renameSession(sessionId, "  doomed rename  ");
      });
      expect(apiMocks.setSessionTitle).toHaveBeenCalledWith(
        sessionId,
        "doomed rename",
      );

      await flushReactWork();
      expect(latest?.sessions.find((s) => s.id === sessionId)?.title).toBe(
        "old title",
      );
      expect(JSON.parse(localStorage.getItem(SESSION_TITLES_KEY) || "{}")).toEqual({
        [sessionId]: "old title",
      });
      expect(warn).toHaveBeenCalledWith(
        `renameSession failed for ${sessionId}: forbidden: invalid title`,
      );
    } finally {
      harness.unmount();
    }
  });

  it("applies cross-tab session title updates from the runtime subscriber event", async () => {
    const sessionId = idAt(84, "title-event");
    apiMocks.listSessions.mockResolvedValue([
      { id: sessionId, message_count: 2, title: "old title" },
    ] satisfies SessionInfo[]);

    let latest: SessionContextValue | null = null;
    const harness = mountSessionProvider((ctx) => {
      latest = ctx;
    });
    try {
      await flushReactWork();
      expect(latest?.sessions.find((s) => s.id === sessionId)?.title).toBe(
        "old title",
      );

      act(() => {
        window.dispatchEvent(
          new CustomEvent("crew:session_title_updated", {
            detail: { session_id: sessionId, title: "server title" },
          }),
        );
      });

      expect(latest?.sessions.find((s) => s.id === sessionId)?.title).toBe(
        "server title",
      );
      expect(JSON.parse(localStorage.getItem(SESSION_TITLES_KEY) || "{}")).toEqual({
        [sessionId]: "server title",
      });
    } finally {
      harness.unmount();
    }
  });
});

describe("SessionProvider background task rehydration", () => {
  it("rehydrates recent background tasks on reload so non-current sidebar rows show live", async () => {
    const busySessionId = idAt(120, "busy");
    const idleSessionId = idAt(240, "idle");
    const busyTask = backgroundTask("task-running-after-reload");
    apiMocks.listSessions.mockResolvedValue([
      { id: busySessionId, message_count: 2, title: "busy chat" },
      { id: idleSessionId, message_count: 2, title: "idle chat" },
    ] satisfies SessionInfo[]);
    apiMocks.getSessionTasks.mockImplementation(async (sessionId: string) =>
      sessionId === busySessionId ? [busyTask] : [],
    );

    const harness = mountSessionList();
    try {
      await flushReactWork(16);

      expect(apiMocks.getSessionTasks).toHaveBeenCalledWith(busySessionId);
      expect(apiMocks.getSessionTasks).toHaveBeenCalledWith(idleSessionId);
      expect(TaskStore.getTasks(busySessionId).map((task) => task.id)).toEqual([
        busyTask.id,
      ]);

      const busyRow = harness.container.querySelector(
        `[data-session-id="${busySessionId}"]`,
      );
      const idleRow = harness.container.querySelector(
        `[data-session-id="${idleSessionId}"]`,
      );
      expect(busyRow?.textContent).toContain("Live session");
      expect(idleRow?.textContent).toContain("Saved session");
    } finally {
      harness.unmount();
      TaskStore.clearTasks(busySessionId);
      TaskStore.clearTasks(idleSessionId);
    }
  });
});

// ---------------------------------------------------------------------------
// renameSession optimistic + rollback helpers (octos-web #106 review)
// ---------------------------------------------------------------------------
//
// The full `renameSession` callback lives inside `SessionProvider` and
// touches refs + `setSessions`. We exercise the two pure helpers that
// `renameSession` is composed of (`applyOptimisticRename` and
// `rollbackOptimisticRename`), plus a behavior-level test that runs the
// real promise rejection path against a mocked `setSessionTitle` and
// asserts the documented rollback (cache restored, sessions[] rolled
// back, `console.warn` called).
//
// We deliberately avoid `@testing-library/react` (not a dep) by
// reproducing the exact rollback wiring from session-context.tsx — same
// helpers, same mocked apiSetSessionTitle, same console.warn — so a
// regression in the helpers (or in the wiring inside renameSession that
// uses them) is caught by these unit tests.

describe("applyOptimisticRename", () => {
  it("patches the title of an existing session row", () => {
    const prev: SessionWithTitle[] = [
      { id: "web-1", message_count: 3, title: "old" },
      { id: "web-2", message_count: 1, title: "other" },
    ];
    const next = applyOptimisticRename(prev, "web-1", "new title");
    expect(next).toHaveLength(2);
    expect(next.find((s) => s.id === "web-1")?.title).toBe("new title");
    expect(next.find((s) => s.id === "web-2")?.title).toBe("other");
  });

  it("prepends a _local placeholder when the session is unknown", () => {
    const prev: SessionWithTitle[] = [
      { id: "web-1", message_count: 3, title: "old" },
    ];
    const next = applyOptimisticRename(prev, "web-new", "fresh");
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({
      id: "web-new",
      message_count: 0,
      title: "fresh",
      _local: true,
    });
    expect(next[1].id).toBe("web-1");
  });
});

describe("rollbackOptimisticRename", () => {
  it("restores the previous title when one existed", () => {
    const prev: SessionWithTitle[] = [
      { id: "web-1", message_count: 3, title: "current optimistic" },
    ];
    const next = rollbackOptimisticRename(prev, "web-1", "earlier title");
    expect(next.find((s) => s.id === "web-1")?.title).toBe("earlier title");
  });

  it("drops a placeholder row when previousTitle is undefined", () => {
    const prev: SessionWithTitle[] = [
      {
        id: "web-new",
        message_count: 0,
        title: "optimistic",
        _local: true,
      },
      { id: "web-1", message_count: 3, title: "other" },
    ];
    const next = rollbackOptimisticRename(prev, "web-new", undefined);
    expect(next.map((s) => s.id)).toEqual(["web-1"]);
  });

  it("clears the title on an existing row when no previous cached title", () => {
    // Rename an existing session whose title was never cached: the
    // optimistic write set it for the first time. Rolling back means
    // clearing the title back to undefined, NOT dropping the row.
    const prev: SessionWithTitle[] = [
      { id: "web-1", message_count: 3, title: "just-typed" },
    ];
    const next = rollbackOptimisticRename(prev, "web-1", undefined);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("web-1");
    expect(next[0].title).toBeUndefined();
  });
});

describe("renameSession rollback wiring (replicated from SessionProvider)", () => {
  // Mirror of the catch handler in `renameSession`. If you refactor the
  // production handler, mirror the change here. The goal of this test is
  // to lock in the rollback contract (cache restore + sessions rollback
  // + console.warn) end-to-end, without standing up a React tree.
  function runRenameWithRollback(opts: {
    sessionId: string;
    newTitle: string;
    previousTitle: string | undefined;
    titleCache: Record<string, string>;
    initialSessions: SessionWithTitle[];
    api: (id: string, title: string) => Promise<unknown>;
    onSessionsChange: (next: SessionWithTitle[]) => void;
  }): Promise<void> {
    const trimmed = opts.newTitle.trim();
    // Optimistic.
    opts.titleCache[opts.sessionId] = trimmed;
    const optimisticSessions = applyOptimisticRename(
      opts.initialSessions,
      opts.sessionId,
      trimmed,
    );
    opts.onSessionsChange(optimisticSessions);
    return opts.api(opts.sessionId, trimmed).then(
      () => undefined,
      (err: unknown) => {
        if (opts.previousTitle !== undefined) {
          opts.titleCache[opts.sessionId] = opts.previousTitle;
        } else {
          delete opts.titleCache[opts.sessionId];
        }
        opts.onSessionsChange(
          rollbackOptimisticRename(
            optimisticSessions,
            opts.sessionId,
            opts.previousTitle,
          ),
        );
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`renameSession failed for ${opts.sessionId}: ${message}`);
      },
    );
  }

  it("persists the title on success without touching the rollback path", async () => {
    const calls: Array<{ id: string; title: string }> = [];
    const api = (id: string, title: string) => {
      calls.push({ id, title });
      return Promise.resolve({ session_id: id, title });
    };
    const titleCache: Record<string, string> = {};
    let latest: SessionWithTitle[] = [
      { id: "web-1", message_count: 3, title: undefined },
    ];
    await runRenameWithRollback({
      sessionId: "web-1",
      newTitle: "  My Chat  ",
      previousTitle: undefined,
      titleCache,
      initialSessions: latest,
      api,
      onSessionsChange: (next) => {
        latest = next;
      },
    });
    expect(calls).toEqual([{ id: "web-1", title: "My Chat" }]);
    expect(titleCache).toEqual({ "web-1": "My Chat" });
    expect(latest.find((s) => s.id === "web-1")?.title).toBe("My Chat");
  });

  it("rolls back the cache + sessions[] when the wrapper rejects", async () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const api = () =>
        Promise.reject(new Error("forbidden: invalid title"));
      const titleCache: Record<string, string> = { "web-1": "old cached" };
      let latest: SessionWithTitle[] = [
        { id: "web-1", message_count: 3, title: "old cached" },
      ];
      await runRenameWithRollback({
        sessionId: "web-1",
        newTitle: "doomed",
        previousTitle: "old cached",
        titleCache,
        initialSessions: latest,
        api,
        onSessionsChange: (next) => {
          latest = next;
        },
      });
      expect(titleCache).toEqual({ "web-1": "old cached" });
      expect(latest.find((s) => s.id === "web-1")?.title).toBe("old cached");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("web-1");
      expect(warnings[0]).toContain("forbidden: invalid title");
    } finally {
      console.warn = warn;
    }
  });

  it("clears the cache entry on rejection when no previous title existed", async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const api = () => Promise.reject(new Error("offline"));
      const titleCache: Record<string, string> = {};
      let latest: SessionWithTitle[] = [
        { id: "web-1", message_count: 3, title: undefined },
      ];
      await runRenameWithRollback({
        sessionId: "web-1",
        newTitle: "first try",
        previousTitle: undefined,
        titleCache,
        initialSessions: latest,
        api,
        onSessionsChange: (next) => {
          latest = next;
        },
      });
      // Cache entry deleted so the next refreshSessions() can re-fetch
      // a server-canonical title.
      expect(titleCache["web-1"]).toBeUndefined();
      // Sessions[] rolled back to the pre-rename state.
      expect(latest.find((s) => s.id === "web-1")?.title).toBeUndefined();
    } finally {
      console.warn = warn;
    }
  });
});
