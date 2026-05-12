/**
 * Unit tests for the M12 Phase D-2 auxiliary REST-to-WS wrappers.
 *
 * Each of the 13 wrappers in `src/api/sessions.ts` / `src/api/content.ts`
 * routes one of two ways based on:
 *   - `octos_auxiliary_rest_to_ws_v1` localStorage flag (on / off)
 *   - presence of a connected bridge in the UI Protocol v1 runtime
 *
 * These tests pin both legs:
 *   - flag OFF → flag-off REST path runs the existing `fetch` against
 *     the legacy REST handler.
 *   - flag ON + connected bridge → wrapper calls `bridge.callMethod()`
 *     with the JSON-RPC params the server expects (golden shape from
 *     `aux_rest_to_ws_v1_request_dtos_match_json_goldens` in
 *     `crates/octos-core/src/ui_protocol.rs`).
 *   - flag ON + no bridge → graceful fallback to REST so panels that
 *     load before a chat session is open still work.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  __setAuxRestToWsV1ForTests,
  isAuxRestToWsV1Enabled,
} from "@/lib/feature-flags";
import { __resetUiProtocolRuntimeForTest, __setActiveBridgeForTest } from "@/runtime/ui-protocol-runtime";
import { METHODS, type UiProtocolBridge } from "@/runtime/ui-protocol-bridge";
import { TOKEN_KEY } from "@/lib/constants";

// SUT
import {
  bulkDeleteContent,
  deleteContent,
  fetchContent,
} from "@/api/content";
import {
  deleteSession,
  getMessages,
  getMessagesPage,
  getSessionFiles,
  getSessionSnapshot,
  getSessionStatus,
  getSessionTasks,
  getSessionWorkspaceContract,
  getStatus,
  listSessions,
  setSessionTitle,
} from "@/api/sessions";

// ---------------------------------------------------------------------------
// Mock bridge factory
// ---------------------------------------------------------------------------

interface MockBridge extends UiProtocolBridge {
  calls: Array<{ method: string; params: unknown }>;
  replies: Map<string, unknown>;
  setReply(method: string, value: unknown): void;
}

function makeMockBridge(): MockBridge {
  const calls: Array<{ method: string; params: unknown }> = [];
  const replies = new Map<string, unknown>();

  const stub: Partial<UiProtocolBridge> = {
    callMethod: async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params: params ?? null });
      if (!replies.has(method)) {
        throw new Error(`mock bridge: no reply queued for ${method}`);
      }
      return replies.get(method) as T;
    },
    // Methods we don't exercise in this suite — stubs that satisfy the
    // interface but throw if accidentally invoked.
    start: async () => {},
    stop: async () => {},
    sendTurn: () => Promise.reject(new Error("not used in this test")),
    interruptTurn: () => Promise.reject(new Error("not used")),
    respondToApproval: () => Promise.reject(new Error("not used")),
    hydrateSession: () => Promise.resolve(null),
    onMessageDelta: () => () => {},
    onMessagePersisted: () => () => {},
    onSpawnComplete: () => () => {},
    onTaskUpdated: () => () => {},
    onTaskOutputDelta: () => () => {},
    onTurnLifecycle: () => () => {},
    onApprovalRequested: () => () => {},
    onConnectionStateChange: () => () => {},
    onWarning: () => () => {},
  };

  return Object.assign(stub as MockBridge, {
    calls,
    replies,
    setReply(method: string, value: unknown) {
      replies.set(method, value);
    },
  });
}

// ---------------------------------------------------------------------------
// Fetch mock helpers (REST fallback path)
// ---------------------------------------------------------------------------

interface FetchCapture {
  url: string;
  init: RequestInit | undefined;
}

let currentFetchMock: ReturnType<typeof vi.fn> | null = null;
let currentCalls: FetchCapture[] | null = null;

function installFetchMock(): { calls: FetchCapture[]; reset: () => void } {
  const calls: FetchCapture[] = [];
  const reset = () => {
    calls.length = 0;
  };

  const fetchMock = vi
    .fn()
    .mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      // Default success body for all REST stubs — each test overrides
      // via `mockResolvedValueOnce` BEFORE invoking the wrapper.
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  vi.stubGlobal("fetch", fetchMock);
  currentFetchMock = fetchMock;
  currentCalls = calls;

  return { calls, reset };
}

function mockFetchOnceJson(body: unknown): void {
  // Wrap the body in a `mockImplementationOnce` that ALSO logs into the
  // shared `calls` array — otherwise the queued one-shot impl bypasses
  // the default impl's bookkeeping and `fetchCalls` stays empty.
  const capture = currentCalls;
  currentFetchMock?.mockImplementationOnce(
    async (url: string, init?: RequestInit) => {
      capture?.push({ url, init });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
}

function mockFetchOnce204(): void {
  const capture = currentCalls;
  currentFetchMock?.mockImplementationOnce(
    async (url: string, init?: RequestInit) => {
      capture?.push({ url, init });
      return new Response(null, { status: 204 });
    },
  );
}

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

let fetchCalls: FetchCapture[];
let resetFetchCalls: () => void;

beforeEach(() => {
  __resetUiProtocolRuntimeForTest();
  __setAuxRestToWsV1ForTests(false);
  // Auth bookkeeping — `request()` reads the token from localStorage to
  // build the Authorization header on the REST fallback.
  try {
    globalThis.localStorage?.setItem(TOKEN_KEY, "test-token");
  } catch {
    // jsdom always provides localStorage
  }
  const installed = installFetchMock();
  fetchCalls = installed.calls;
  resetFetchCalls = installed.reset;
});

afterEach(() => {
  __setAuxRestToWsV1ForTests(false);
  __resetUiProtocolRuntimeForTest();
  resetFetchCalls();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  currentFetchMock = null;
  currentCalls = null;
});

// ---------------------------------------------------------------------------
// Flag plumbing
// ---------------------------------------------------------------------------

describe("auxiliary_rest_to_ws_v1 feature flag", () => {
  it("defaults OFF", () => {
    expect(isAuxRestToWsV1Enabled()).toBe(false);
  });

  it("reads `1` from localStorage as ON", () => {
    __setAuxRestToWsV1ForTests(true);
    expect(isAuxRestToWsV1Enabled()).toBe(true);
  });

  it("returns to OFF after the test helper resets it", () => {
    __setAuxRestToWsV1ForTests(true);
    expect(isAuxRestToWsV1Enabled()).toBe(true);
    __setAuxRestToWsV1ForTests(false);
    expect(isAuxRestToWsV1Enabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session wrappers
// ---------------------------------------------------------------------------

describe("listSessions [session/list]", () => {
  it("flag OFF → calls REST /api/sessions", async () => {
    mockFetchOnceJson([{ id: "s-1", message_count: 0 }]);
    const result = await listSessions();
    expect(fetchCalls[0].url).toBe("/api/sessions");
    expect(result).toEqual([{ id: "s-1", message_count: 0 }]);
  });

  it("flag ON + connected bridge → calls WS session/list", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_LIST, {
      sessions: [{ id: "s-2", message_count: 5 }],
    });
    __setActiveBridgeForTest("any", bridge);

    const result = await listSessions();
    expect(bridge.calls).toEqual([
      { method: METHODS.SESSION_LIST, params: {} },
    ]);
    expect(fetchCalls).toEqual([]); // no REST hit
    expect(result).toEqual([{ id: "s-2", message_count: 5 }]);
  });

  it("flag ON + no bridge → falls back to REST", async () => {
    __setAuxRestToWsV1ForTests(true);
    mockFetchOnceJson([{ id: "s-3", message_count: 1 }]);
    const result = await listSessions();
    expect(fetchCalls[0].url).toBe("/api/sessions");
    expect(result).toEqual([{ id: "s-3", message_count: 1 }]);
  });
});

describe("getMessages [session/messages_page]", () => {
  it("flag OFF → calls REST with paginated query string", async () => {
    mockFetchOnceJson([
      { role: "user", content: "hello", timestamp: "2026-05-12T00:00:00Z" },
    ]);
    const msgs = await getMessages("sess-x", 100, 0, 42, "topic-a");
    expect(fetchCalls[0].url).toContain(
      "/api/sessions/sess-x/messages?",
    );
    expect(fetchCalls[0].url).toContain("limit=100");
    expect(fetchCalls[0].url).toContain("offset=0");
    expect(fetchCalls[0].url).toContain("source=full");
    expect(fetchCalls[0].url).toContain("since_seq=42");
    expect(fetchCalls[0].url).toContain("topic=topic-a");
    expect(msgs.length).toBe(1);
  });

  it("flag ON → calls WS session/messages_page with golden params", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_MESSAGES_PAGE, {
      messages: [
        {
          role: "assistant",
          content: "hi",
          timestamp: "2026-05-12T00:00:00Z",
        },
      ],
      has_more: false,
      next_offset: 1,
    });
    __setActiveBridgeForTest("any", bridge);

    const msgs = await getMessages("sess-2", 50, 10, 100);
    expect(bridge.calls[0].method).toBe(METHODS.SESSION_MESSAGES_PAGE);
    expect(bridge.calls[0].params).toEqual({
      session_id: "sess-2",
      limit: 50,
      offset: 10,
      since_seq: 100,
    });
    expect(msgs.length).toBe(1);
  });
});

describe("getMessagesPage", () => {
  it("flag ON → returns WS page metadata verbatim", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_MESSAGES_PAGE, {
      messages: [],
      has_more: true,
      next_offset: 200,
    });
    __setActiveBridgeForTest("any", bridge);

    const page = await getMessagesPage("sess-3", 100, 100);
    expect(page).toEqual({ messages: [], has_more: true, next_offset: 200 });
  });

  it("flag OFF → synthesizes has_more from page length", async () => {
    // Page returns exactly `limit` rows → has_more=true, next_offset=limit
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
      timestamp: "2026-05-12T00:00:00Z",
    }));
    mockFetchOnceJson(messages);
    const page = await getMessagesPage("sess-3", 100, 0);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(100);
    expect(page.messages.length).toBe(100);
  });

  // M12 Phase D-2 codex review (MEDIUM 1): the WS transport clamps
  // limit→500 and offset→10000 server-side. The REST fallback used to
  // synthesize `next_offset` from the caller's raw args, so
  // `getMessagesPage(id, 1000)` reported different metadata across
  // transports. The wrapper now clamps once up-front so the metadata
  // is identical regardless of transport.
  it("clamps over-limit and over-offset args to the same caps on both transports", async () => {
    // First leg: flag OFF, REST path with limit=1000 (clamped to 500),
    // offset=20000 (clamped to 10000). REST returns 500 rows → has_more.
    const oversized = Array.from({ length: 500 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
      timestamp: "2026-05-12T00:00:00Z",
    }));
    mockFetchOnceJson(oversized);
    const restPage = await getMessagesPage("sess-clamp", 1000, 20000);
    // REST URL should embed the CLAMPED values, not the raw ones.
    expect(fetchCalls[0].url).toContain("limit=500");
    expect(fetchCalls[0].url).toContain("offset=10000");
    expect(restPage.has_more).toBe(true);
    expect(restPage.next_offset).toBe(10500); // 10000 + 500

    // Second leg: flag ON, WS path with the same args. The bridge must
    // see the clamped values, not the raw ones. The server returns
    // metadata derived from clamped values too.
    resetFetchCalls();
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_MESSAGES_PAGE, {
      messages: [],
      has_more: true,
      next_offset: 10500,
    });
    __setActiveBridgeForTest("any", bridge);

    const wsPage = await getMessagesPage("sess-clamp", 1000, 20000);
    expect(bridge.calls[0].params).toEqual({
      session_id: "sess-clamp",
      limit: 500,
      offset: 10000,
    });
    // Both transports report the same next_offset for the same caller args.
    expect(wsPage.next_offset).toBe(restPage.next_offset);
    expect(wsPage.has_more).toBe(restPage.has_more);
  });
});

describe("getSessionStatus [session/status.get]", () => {
  it("flag OFF → calls REST /status with optional topic", async () => {
    mockFetchOnceJson({
      active: true,
      has_deferred_files: false,
      has_bg_tasks: false,
    });
    const s = await getSessionStatus("sess-a", "t1");
    expect(fetchCalls[0].url).toBe("/api/sessions/sess-a/status?topic=t1");
    expect(s.active).toBe(true);
  });

  it("flag ON → calls WS session/status.get and unwraps `status`", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_STATUS_GET, {
      status: {
        active: false,
        has_deferred_files: true,
        has_bg_tasks: true,
      },
    });
    __setActiveBridgeForTest("any", bridge);

    const s = await getSessionStatus("sess-a");
    expect(bridge.calls[0].params).toEqual({ session_id: "sess-a" });
    expect(s).toEqual({
      active: false,
      has_deferred_files: true,
      has_bg_tasks: true,
    });
  });
});

describe("getSessionFiles [session/files.list]", () => {
  it("flag OFF → REST /files", async () => {
    mockFetchOnceJson([
      {
        filename: "a.txt",
        path: "p/a.txt",
        size_bytes: 1,
        modified_at: "2026-05-12T00:00:00Z",
      },
    ]);
    const files = await getSessionFiles("sess-b");
    expect(fetchCalls[0].url).toBe("/api/sessions/sess-b/files");
    expect(files.length).toBe(1);
  });

  it("flag ON → WS session/files.list, unwraps `files`", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_FILES_LIST, {
      files: [
        {
          filename: "b.txt",
          path: "p/b.txt",
          size_bytes: 2,
          modified_at: "2026-05-12T00:00:00Z",
        },
      ],
    });
    __setActiveBridgeForTest("any", bridge);

    const files = await getSessionFiles("sess-b");
    expect(bridge.calls[0].params).toEqual({ session_id: "sess-b" });
    expect(files.length).toBe(1);
    expect(files[0].filename).toBe("b.txt");
  });
});

describe("getSessionTasks [session/tasks.list]", () => {
  it("flag OFF → REST /tasks", async () => {
    mockFetchOnceJson([]);
    const tasks = await getSessionTasks("sess-c", "t");
    expect(fetchCalls[0].url).toBe("/api/sessions/sess-c/tasks?topic=t");
    expect(tasks).toEqual([]);
  });

  it("flag ON → WS session/tasks.list with topic", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_TASKS_LIST, { tasks: [] });
    __setActiveBridgeForTest("any", bridge);

    await getSessionTasks("sess-c", "t");
    expect(bridge.calls[0].params).toEqual({
      session_id: "sess-c",
      topic: "t",
    });
  });
});

describe("getSessionWorkspaceContract [session/workspace.get]", () => {
  it("flag OFF → REST /workspace-contract", async () => {
    mockFetchOnceJson([]);
    await getSessionWorkspaceContract("sess-d");
    expect(fetchCalls[0].url).toBe(
      "/api/sessions/sess-d/workspace-contract",
    );
  });

  it("flag ON → WS session/workspace.get, unwraps `contracts`", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_WORKSPACE_GET, { contracts: [] });
    __setActiveBridgeForTest("any", bridge);

    const out = await getSessionWorkspaceContract("sess-d");
    expect(bridge.calls[0].params).toEqual({ session_id: "sess-d" });
    expect(out).toEqual([]);
  });
});

describe("getSessionSnapshot [session/snapshot]", () => {
  it("flag OFF → issues 3 parallel REST calls", async () => {
    // status, files, tasks (in unspecified order; the wrapper uses Promise.all)
    mockFetchOnceJson({
      active: true,
      has_deferred_files: false,
      has_bg_tasks: false,
    });
    mockFetchOnceJson([]);
    mockFetchOnceJson([]);
    const snap = await getSessionSnapshot("sess-e");
    expect(fetchCalls.length).toBe(3);
    expect(snap.status.active).toBe(true);
    expect(snap.files).toEqual([]);
    expect(snap.tasks).toEqual([]);
  });

  it("flag ON → one WS session/snapshot call", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_SNAPSHOT, {
      status: {
        active: false,
        has_deferred_files: false,
        has_bg_tasks: false,
      },
      files: [],
      tasks: [],
    });
    __setActiveBridgeForTest("any", bridge);

    const snap = await getSessionSnapshot("sess-e", "topic-z");
    expect(bridge.calls.length).toBe(1);
    expect(bridge.calls[0].method).toBe(METHODS.SESSION_SNAPSHOT);
    expect(bridge.calls[0].params).toEqual({
      session_id: "sess-e",
      topic: "topic-z",
    });
    expect(snap.status.active).toBe(false);
  });
});

describe("setSessionTitle [session/title.set]", () => {
  it("flag OFF → REST PATCH /title", async () => {
    mockFetchOnce204();
    const out = await setSessionTitle("sess-f", "New title");
    expect(fetchCalls[0].url).toBe("/api/sessions/sess-f/title");
    expect(fetchCalls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      title: "New title",
    });
    expect(out).toEqual({ session_id: "sess-f", title: "New title" });
  });

  it("flag ON → WS session/title.set echoes the rename", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_TITLE_SET, {
      session_id: "sess-f",
      title: "Better title",
    });
    __setActiveBridgeForTest("any", bridge);

    const out = await setSessionTitle("sess-f", "Better title");
    expect(bridge.calls[0].params).toEqual({
      session_id: "sess-f",
      title: "Better title",
    });
    expect(out).toEqual({ session_id: "sess-f", title: "Better title" });
  });
});

describe("deleteSession [session/delete]", () => {
  it("flag OFF → REST DELETE", async () => {
    mockFetchOnce204();
    await deleteSession("sess-g");
    expect(fetchCalls[0].url).toBe("/api/sessions/sess-g");
    expect(fetchCalls[0].init?.method).toBe("DELETE");
  });

  it("flag ON → WS session/delete", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_DELETE, {});
    __setActiveBridgeForTest("any", bridge);

    await deleteSession("sess-g");
    expect(bridge.calls[0].method).toBe(METHODS.SESSION_DELETE);
    expect(bridge.calls[0].params).toEqual({ session_id: "sess-g" });
  });
});

// ---------------------------------------------------------------------------
// System wrappers
// ---------------------------------------------------------------------------

describe("getStatus [system/status.get]", () => {
  it("flag OFF → REST /api/status", async () => {
    mockFetchOnceJson({
      version: "0.1.0",
      model: "x",
      provider: "y",
      uptime_secs: 42,
      agent_configured: true,
    });
    const s = await getStatus();
    expect(fetchCalls[0].url).toBe("/api/status");
    expect(s.version).toBe("0.1.0");
  });

  it("flag ON → WS system/status.get, unwraps `status`", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SYSTEM_STATUS_GET, {
      status: {
        version: "0.2.0",
        model: "m",
        provider: "p",
        uptime_secs: 7,
        agent_configured: false,
      },
    });
    __setActiveBridgeForTest("any", bridge);

    const s = await getStatus();
    expect(bridge.calls[0].method).toBe(METHODS.SYSTEM_STATUS_GET);
    expect(bridge.calls[0].params).toEqual({});
    expect(s.version).toBe("0.2.0");
  });
});

// ---------------------------------------------------------------------------
// Content wrappers
// ---------------------------------------------------------------------------

describe("fetchContent [content/list]", () => {
  it("flag OFF → REST /api/my/content with query string", async () => {
    mockFetchOnceJson({ entries: [], total: 0 });
    await fetchContent({ category: "image", limit: 50 });
    expect(fetchCalls[0].url).toBe(
      "/api/my/content?category=image&limit=50",
    );
  });

  it("flag ON → WS content/list with `filters` wrapper", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.CONTENT_LIST, {
      entries: [{ id: "c-1" }],
      total: 1,
    });
    __setActiveBridgeForTest("any", bridge);

    const out = await fetchContent({ category: "image", limit: 50 });
    expect(bridge.calls[0].method).toBe(METHODS.CONTENT_LIST);
    expect(bridge.calls[0].params).toEqual({
      filters: { category: "image", limit: 50 },
    });
    expect(out.total).toBe(1);
  });

  it("flag ON + sessionId filter → maps to session_id on the wire", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.CONTENT_LIST, { entries: [], total: 0 });
    __setActiveBridgeForTest("any", bridge);

    await fetchContent({ sessionId: "abc" });
    expect(bridge.calls[0].params).toEqual({
      filters: { session_id: "abc" },
    });
  });

  // M12 Phase D-2 codex review (MEDIUM 2): the WS path filters by
  // `filters.session_id` server-side. The REST GET endpoint has no
  // equivalent query param, so direct `fetchContent({sessionId})`
  // callers used to see UNFILTERED results when the flag was OFF
  // (the store worked around it by client-filtering, but only
  // `loadContent` did so). The REST fallback now applies the same
  // client-side filter so caller-observable behavior is byte-identical
  // across transports.
  it("fetchContent({sessionId}) returns same filtered subset across transports", async () => {
    const backendEntries = [
      {
        id: "a",
        filename: "a.txt",
        path: "/api/sessions/sess-x/files/a.txt",
        category: "report" as const,
        size_bytes: 1,
        created_at: "2026-05-12T00:00:00Z",
        thumbnail_path: null,
        session_id: "sess-x",
        tool_name: null,
        caption: null,
      },
      {
        id: "b",
        filename: "b.txt",
        path: "/api/sessions/sess-y/files/b.txt",
        category: "report" as const,
        size_bytes: 1,
        created_at: "2026-05-12T00:00:00Z",
        thumbnail_path: null,
        session_id: "sess-y",
        tool_name: null,
        caption: null,
      },
    ];

    // Leg 1: flag OFF (REST) — the server returns all entries, the
    // wrapper filters client-side to those matching session_id.
    mockFetchOnceJson({ entries: backendEntries, total: 2 });
    const restOut = await fetchContent({ sessionId: "sess-x" });
    expect(restOut.entries.map((e) => e.id)).toEqual(["a"]);
    expect(restOut.total).toBe(1);

    // Leg 2: flag ON (WS) — the server pre-filters; wrapper passes
    // result through unchanged. Same caller-observable shape.
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.CONTENT_LIST, {
      entries: [backendEntries[0]],
      total: 1,
    });
    __setActiveBridgeForTest("any", bridge);
    const wsOut = await fetchContent({ sessionId: "sess-x" });
    expect(wsOut.entries.map((e) => e.id)).toEqual(["a"]);
    expect(wsOut.total).toBe(1);

    // Equal under both transports.
    expect(wsOut).toEqual(restOut);
  });
});

describe("deleteContent [content/delete]", () => {
  it("flag OFF → REST DELETE /api/my/content/:id", async () => {
    mockFetchOnce204();
    await deleteContent("c-1");
    expect(fetchCalls[0].url).toBe("/api/my/content/c-1");
    expect(fetchCalls[0].init?.method).toBe("DELETE");
  });

  it("flag ON → WS content/delete", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.CONTENT_DELETE, { deleted: true });
    __setActiveBridgeForTest("any", bridge);

    await deleteContent("c-1");
    expect(bridge.calls[0].method).toBe(METHODS.CONTENT_DELETE);
    expect(bridge.calls[0].params).toEqual({ id: "c-1" });
  });
});

describe("bulkDeleteContent [content/bulk_delete]", () => {
  it("flag OFF → REST POST /bulk-delete", async () => {
    mockFetchOnce204();
    await bulkDeleteContent(["c-1", "c-2"]);
    expect(fetchCalls[0].url).toBe("/api/my/content/bulk-delete");
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(JSON.parse(fetchCalls[0].init?.body as string)).toEqual({
      ids: ["c-1", "c-2"],
    });
  });

  it("flag ON → WS content/bulk_delete with `ids` array", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.CONTENT_BULK_DELETE, { deleted: 2 });
    __setActiveBridgeForTest("any", bridge);

    await bulkDeleteContent(["c-1", "c-2"]);
    expect(bridge.calls[0].method).toBe(METHODS.CONTENT_BULK_DELETE);
    expect(bridge.calls[0].params).toEqual({ ids: ["c-1", "c-2"] });
  });

  // M12 Phase D-2 codex review (MEDIUM 3): the WS dispatcher caps
  // `content/bulk_delete` at 256 IDs server-side. The REST endpoint
  // has no equivalent cap, so a 300-ID delete used to succeed with
  // the flag OFF and fail with the flag ON. The wrapper now chunks
  // client-side to BATCH_SIZE on both transports so 300 IDs succeed
  // regardless of flag state.
  it("chunks 300 IDs into 2 batches (256 + 44) on the WS transport", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.CONTENT_BULK_DELETE, { deleted: 256 });
    __setActiveBridgeForTest("any", bridge);

    const ids = Array.from({ length: 300 }, (_, i) => `c-${i}`);
    const out = await bulkDeleteContent(ids);

    // Two chunks: 256 + 44.
    expect(bridge.calls.length).toBe(2);
    expect((bridge.calls[0].params as { ids: string[] }).ids.length).toBe(256);
    expect((bridge.calls[1].params as { ids: string[] }).ids.length).toBe(44);
    // First chunk's first ID is the array's first ID.
    expect((bridge.calls[0].params as { ids: string[] }).ids[0]).toBe("c-0");
    // Second chunk starts at index 256.
    expect((bridge.calls[1].params as { ids: string[] }).ids[0]).toBe("c-256");
    // Aggregated count tracks per-chunk replies.
    expect(out.deleted_count).toBe(512); // both replies returned `deleted: 256`
    expect(out.failed_ids).toEqual([]);
  });

  it("chunks 300 IDs into 2 batches on the REST transport too", async () => {
    // Default fetchMock returns 200 OK for every call. The wrapper
    // counts each chunk's length when no `deleted` body is returned.
    const ids = Array.from({ length: 300 }, (_, i) => `c-${i}`);
    const out = await bulkDeleteContent(ids);

    // Two REST POSTs.
    expect(fetchCalls.length).toBe(2);
    const body1 = JSON.parse(fetchCalls[0].init?.body as string);
    const body2 = JSON.parse(fetchCalls[1].init?.body as string);
    expect(body1.ids.length).toBe(256);
    expect(body2.ids.length).toBe(44);
    expect(out.deleted_count).toBe(300);
    expect(out.failed_ids).toEqual([]);
  });

  it("handles edge sizes 0, 1, 256, 257 correctly", async () => {
    // 0 IDs → no transport call.
    const empty = await bulkDeleteContent([]);
    expect(fetchCalls.length).toBe(0);
    expect(empty).toEqual({ deleted_count: 0, failed_ids: [] });

    // 1 ID → exactly one chunk of 1.
    const one = await bulkDeleteContent(["c-only"]);
    expect(fetchCalls.length).toBe(1);
    expect(JSON.parse(fetchCalls[0].init?.body as string).ids).toEqual([
      "c-only",
    ]);
    expect(one.deleted_count).toBe(1);

    // 256 IDs → exactly one chunk.
    resetFetchCalls();
    await bulkDeleteContent(Array.from({ length: 256 }, (_, i) => `c-${i}`));
    expect(fetchCalls.length).toBe(1);
    expect(JSON.parse(fetchCalls[0].init?.body as string).ids.length).toBe(256);

    // 257 IDs → two chunks (256 + 1).
    resetFetchCalls();
    await bulkDeleteContent(Array.from({ length: 257 }, (_, i) => `c-${i}`));
    expect(fetchCalls.length).toBe(2);
    expect(JSON.parse(fetchCalls[0].init?.body as string).ids.length).toBe(256);
    expect(JSON.parse(fetchCalls[1].init?.body as string).ids.length).toBe(1);
  });

  it("returns aggregated failed_ids when a chunk fails (REST)", async () => {
    // First chunk: 256 IDs succeed (default fetchMock returns 200).
    // Second chunk: forced 500. The wrapper aggregates failed_ids
    // instead of throwing so callers can see partial-success.
    currentFetchMock?.mockImplementationOnce(
      async (url: string, init?: RequestInit) => {
        currentCalls?.push({ url, init });
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    currentFetchMock?.mockImplementationOnce(
      async (url: string, init?: RequestInit) => {
        currentCalls?.push({ url, init });
        return new Response("server boom", { status: 500 });
      },
    );

    const ids = Array.from({ length: 300 }, (_, i) => `c-${i}`);
    const out = await bulkDeleteContent(ids);

    // Chunk 1 (256 IDs) succeeded; chunk 2 (44 IDs) failed.
    expect(out.deleted_count).toBe(256);
    expect(out.failed_ids.length).toBe(44);
    expect(out.failed_ids[0]).toBe("c-256");
  });
});

// ---------------------------------------------------------------------------
// Feature flag — mid-session flip is ignored (NIT 1)
// ---------------------------------------------------------------------------
describe("auxiliary_rest_to_ws_v1 mid-session flip semantics", () => {
  it("flipping the flag mid-session does NOT change subsequent wrapper routing", async () => {
    // Initial read latches the flag value to OFF.
    expect(isAuxRestToWsV1Enabled()).toBe(false);

    // Flip storage directly WITHOUT calling the test reset helper, so
    // the cached value stays. This mirrors a user toggling the flag in
    // localStorage from devtools mid-session.
    globalThis.localStorage?.setItem("octos_auxiliary_rest_to_ws_v1", "1");

    // Cached value still wins. (One-shot warn fires once and is then
    // suppressed.)
    expect(isAuxRestToWsV1Enabled()).toBe(false);

    // Wrapper routing must follow the latched value — REST path, not WS.
    mockFetchOnceJson([]);
    const bridge = makeMockBridge();
    bridge.setReply(METHODS.SESSION_LIST, { sessions: [{ id: "should-not-see" }] });
    __setActiveBridgeForTest("any", bridge);
    const out = await listSessions();
    // Routed through REST because the cached flag is still OFF.
    expect(fetchCalls.length).toBe(1);
    expect(bridge.calls.length).toBe(0);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

describe("error envelope translation", () => {
  it("flag ON + bridge RPC error → throws plain Error with server message", async () => {
    __setAuxRestToWsV1ForTests(true);
    const bridge = makeMockBridge();
    // Inject a callMethod that throws BridgeRpcError-style failure.
    bridge.callMethod = (async (): Promise<never> => {
      const { BridgeRpcError } = await import("@/runtime/ui-protocol-bridge");
      throw new BridgeRpcError(-32601, "method_not_supported", null);
    }) as UiProtocolBridge["callMethod"];
    __setActiveBridgeForTest("any", bridge);

    let caught: unknown;
    try {
      await listSessions();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("method_not_supported");
  });
});
