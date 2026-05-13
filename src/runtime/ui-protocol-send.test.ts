/**
 * ui-protocol-send unit tests.
 *
 * M9-α-5/α-6 (ADR PR #830 / audit issue #845): the legacy SSE bridge has
 * been deleted; `/api/ui-protocol/ws` is the sole chat transport.
 *
 * M9-β-1 (UPCR-2026-015 / server PR #860): the WS turn/start envelope
 * gained three optional fields (`media`, `topic`, `rewrite_for`). The
 * tests below assert the bridge dispatches them through unchanged for
 * each variant.
 *
 * Coverage:
 *   - active bridge: dispatches via `bridge.sendTurn` and mirrors the
 *     user message into the thread store
 *   - no active bridge: surfaces an error on the assistant bubble (no
 *     legacy fallback exists anymore)
 *   - β-1 media-bearing sends: `bridge.sendTurn` called with `extras.media`
 *     populated (`FileRef`-shaped entries)
 *   - β-1 topic-scoped sends: `bridge.sendTurn` called with `extras.topic`
 *   - β-1 /queue rewrites: `bridge.sendTurn` called with `extras.rewrite_for`
 *     carrying the original `client_message_id`
 *   - per-session FIFO turn queue contract from M10 follow-up Bug B
 *     (rapid sends serialise behind `turn/completed`/`turn/error`)
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Codex NIT H rewrite: the "failed-start / no-orphan" contract test
// needs `createUiProtocolBridge().start()` to reject. Hoist a per-test
// override slot so individual tests can install a failing factory
// while every other test sees the unmocked production export.
const { __bridgeFactoryOverride } = vi.hoisted(() => ({
  __bridgeFactoryOverride: { current: null as null | (() => unknown) },
}));

vi.mock("./ui-protocol-bridge", async () => {
  const actual =
    await vi.importActual<typeof import("./ui-protocol-bridge")>(
      "./ui-protocol-bridge",
    );
  return {
    ...actual,
    createUiProtocolBridge: (
      ...args: Parameters<typeof actual.createUiProtocolBridge>
    ) => {
      if (__bridgeFactoryOverride.current) {
        return __bridgeFactoryOverride.current() as ReturnType<
          typeof actual.createUiProtocolBridge
        >;
      }
      return actual.createUiProtocolBridge(...args);
    },
  };
});

import * as ThreadStore from "@/store/thread-store";
import {
  sendMessage,
  __resetSendQueueForTest,
} from "./ui-protocol-send";
import {
  __resetUiProtocolRuntimeForTest,
  __setActiveBridgeForTest,
} from "./ui-protocol-runtime";
import type { UiProtocolBridge } from "./ui-protocol-bridge";

const SESSION = "sess-send";

function makeBridge(): UiProtocolBridge & {
  sendTurn: ReturnType<typeof vi.fn>;
  onTurnLifecycle: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendTurn: vi.fn(async () => ({ accepted: true })),
    interruptTurn: vi.fn(async () => ({ interrupted: true })),
    respondToApproval: vi.fn(async () => ({
      approval_id: "x",
      accepted: true,
      status: "ok",
    })),
    onMessageDelta: vi.fn(() => () => {}),
    onMessagePersisted: vi.fn(() => () => {}),
    onTaskUpdated: vi.fn(() => () => {}),
    onTaskOutputDelta: vi.fn(() => () => {}),
    onTurnLifecycle: vi.fn(() => () => {}),
    onApprovalRequested: vi.fn(() => () => {}),
    onConnectionStateChange: vi.fn(() => () => {}),
    getConnectionState: vi.fn(() => "connected"),
    onWarning: vi.fn(() => () => {}),
  } as unknown as UiProtocolBridge & {
    sendTurn: ReturnType<typeof vi.fn>;
    onTurnLifecycle: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  __resetUiProtocolRuntimeForTest();
  __resetSendQueueForTest();
  ThreadStore.__resetForTests();
  window.localStorage.clear();
  __bridgeFactoryOverride.current = null;
});

afterEach(() => {
  window.localStorage.clear();
  __resetUiProtocolRuntimeForTest();
  __resetSendQueueForTest();
  __bridgeFactoryOverride.current = null;
});

describe("sendMessage", () => {
  // Codex NIT H rewrite: this test now exercises the actual #109.1
  // contract — when `startBridgeForSession`'s underlying bridge start
  // REJECTS, no optimistic user row is mirrored AND `onComplete`
  // still fires so the chat input lock releases. Pre-fix the happy
  // path duplicated coverage from "dispatches via bridge.sendTurn and
  // mirrors the user message" below and the failure path was
  // exercised nowhere directly.
  it("issue #109.1: a failed bridge start does NOT orphan a user bubble and fires onComplete", async () => {
    // Install a factory that returns a bridge whose `start()` rejects.
    // No `__setActiveBridgeForTest` here so `enqueueSendV1` hits
    // `startBridgeForSession` → `createUiProtocolBridge().start()` →
    // rejected promise → catch branch in `enqueueSendV1`.
    __bridgeFactoryOverride.current = () => ({
      start: vi.fn(async () => {
        throw new Error("bridge start refused");
      }),
      stop: vi.fn(async () => {}),
      sendTurn: vi.fn(async () => {
        throw new Error("should not be called");
      }),
      interruptTurn: vi.fn(),
      respondToApproval: vi.fn(),
      hydrateSession: vi.fn(async () => null),
      callMethod: vi.fn(),
      onMessageDelta: vi.fn(() => () => {}),
      onMessagePersisted: vi.fn(() => () => {}),
      onSpawnComplete: vi.fn(() => () => {}),
      onTaskUpdated: vi.fn(() => () => {}),
      onTaskOutputDelta: vi.fn(() => () => {}),
      onTurnLifecycle: vi.fn(() => () => {}),
      onApprovalRequested: vi.fn(() => () => {}),
      onConnectionStateChange: vi.fn(() => () => {}),
      getConnectionState: vi.fn(() => "connected"),
      onWarning: vi.fn(() => () => {}),
      onSessionTitleUpdated: vi.fn(() => () => {}),
    });
    const onComplete = vi.fn();

    sendMessage({
      sessionId: SESSION,
      text: "hello-109-1",
      media: [],
      clientMessageId: "cmid-109-1",
      onComplete,
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();

    // No optimistic row materialised — failed start MUST NOT orphan a
    // bubble.
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(0);
    // `onComplete` fired so the composer's sending-lock can release.
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("dispatches via bridge.sendTurn and mirrors the user message", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    sendMessage({
      sessionId: SESSION,
      text: "hello",
      media: [],
      clientMessageId: "cmid-on",
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledWith(
      "cmid-on",
      [{ kind: "text", text: "hello" }],
      undefined,
    );
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].userMsg.text).toBe("hello");
    expect(threads[0].id).toBe("cmid-on");
  });

  // M9-γ-4 (issue #841): when `skipOptimisticUserMessage` is set,
  // `enqueueSendV1` MUST NOT call `addUserMessage`. The Composer renders
  // a `<GhostBubble>` overlay instead, so the durable thread reducer
  // stays free of an optimistic row. The send itself still goes through
  // bridge.sendTurn so the server produces real envelopes.
  it("flag ON (skipOptimisticUserMessage): does NOT mirror into ThreadStore", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    sendMessage({
      sessionId: SESSION,
      text: "ghost",
      media: [],
      clientMessageId: "cmid-ghost",
      skipOptimisticUserMessage: true,
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledWith(
      "cmid-ghost",
      [{ kind: "text", text: "ghost" }],
      undefined,
    );
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(0);
  });

  it("flag OFF (default): mirrors into ThreadStore", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    sendMessage({
      sessionId: SESSION,
      text: "default",
      media: [],
      clientMessageId: "cmid-default",
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("cmid-default");
  });

  it("subscribes to turn lifecycle so onComplete fires on turn/completed", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    const onComplete = vi.fn();

    let lifecycleHandler:
      | ((
          e: { turn_id: string; reason?: string; error?: unknown },
        ) => void)
      | undefined;
    (bridge.onTurnLifecycle as ReturnType<typeof vi.fn>).mockImplementation(
      (h: (e: { turn_id: string; reason?: string; error?: unknown }) => void) => {
        lifecycleHandler = h;
        return () => {
          lifecycleHandler = undefined;
        };
      },
    );

    sendMessage({
      sessionId: SESSION,
      text: "hello",
      media: [],
      clientMessageId: "cmid-complete",
      onComplete,
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(lifecycleHandler).toBeDefined();
    // A different turn's completion must not fire onComplete.
    lifecycleHandler?.({ turn_id: "other", reason: "stop" });
    expect(onComplete).not.toHaveBeenCalled();

    lifecycleHandler?.({ turn_id: "cmid-complete", reason: "stop" });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  // M9-β-1 (UPCR-2026-015): media-bearing turns now ride the WS path.
  // The bridge is called with `extras.media` populated as
  // `FileRef`-shaped entries; the user bubble carries the local files.
  it("forwards media on bridge.sendTurn extras when media is present", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    sendMessage({
      sessionId: SESSION,
      text: "with image",
      media: ["/tmp/foo.png", "/tmp/bar.mp3"],
      clientMessageId: "cmid-media",
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    const call = bridge.sendTurn.mock.calls[0];
    expect(call[0]).toBe("cmid-media");
    expect(call[1]).toEqual([{ kind: "text", text: "with image" }]);
    const extras = call[2];
    expect(extras).toBeDefined();
    expect(extras.media).toHaveLength(2);
    expect(extras.media[0]).toMatchObject({ path: "/tmp/foo.png" });
    expect(extras.media[1]).toMatchObject({ path: "/tmp/bar.mp3" });
    // No error finalisation — the optimistic user bubble is still
    // pending an assistant response.
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads[0].responses[0]?.status).not.toBe("error");
  });

  // M9-β-1: `/queue` rewrites carry the original cmid via
  // `extras.rewrite_for` so the server can replace the queued user
  // message in place rather than appending.
  it("forwards rewrite_for on bridge.sendTurn extras when requestText differs from text", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    sendMessage({
      sessionId: SESSION,
      text: "/queue interrupt",
      requestText: "rewritten request",
      media: [],
      clientMessageId: "cmid-rewrite",
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    const call = bridge.sendTurn.mock.calls[0];
    expect(call[0]).toBe("cmid-rewrite");
    const extras = call[2];
    expect(extras).toBeDefined();
    expect(extras.rewrite_for).toBe("cmid-rewrite");
    expect(extras.media).toBeUndefined();
    expect(extras.topic).toBeUndefined();
  });

  // M9-β-1: topic-scoped sends carry `extras.topic` so the server
  // folds it into the resolved SessionKey before scope validation.
  // The active bridge is registered against the same `(sessionId,
  // topic)` scope the SPA's runtime would publish — `getActiveBridge`
  // gates by scope, so the test mirrors production wiring.
  it("forwards topic on bridge.sendTurn extras when historyTopic is set", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge, "slides");
    sendMessage({
      sessionId: SESSION,
      historyTopic: "slides",
      text: "make a deck",
      media: [],
      clientMessageId: "cmid-topic",
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    const call = bridge.sendTurn.mock.calls[0];
    expect(call[0]).toBe("cmid-topic");
    const extras = call[2];
    expect(extras).toBeDefined();
    expect(extras.topic).toBe("slides");
    expect(extras.media).toBeUndefined();
    expect(extras.rewrite_for).toBeUndefined();
  });

  // M9-β-1: text-only sends produce NO extras envelope so the on-wire
  // shape stays byte-identical to a pre-β-1 build (back-compat).
  it("omits the extras envelope for plain text-only sends", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    sendMessage({
      sessionId: SESSION,
      text: "plain text",
      media: [],
      clientMessageId: "cmid-plain",
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    const call = bridge.sendTurn.mock.calls[0];
    expect(call[2]).toBeUndefined();
  });

  // M9-β-1: when all three β-1 surfaces are populated together (a
  // /queue rewrite under a topic-scoped session that swaps in new
  // media), every extra rides through.
  it("forwards all three β-1 extras when populated together", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge, "research");
    sendMessage({
      sessionId: SESSION,
      historyTopic: "research",
      text: "redo with this image",
      requestText: "edited prompt",
      media: ["/tmp/replacement.png"],
      clientMessageId: "cmid-all",
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    const extras = bridge.sendTurn.mock.calls[0][2];
    expect(extras).toBeDefined();
    expect(extras.media).toHaveLength(1);
    expect(extras.media[0]).toMatchObject({ path: "/tmp/replacement.png" });
    expect(extras.topic).toBe("research");
    expect(extras.rewrite_for).toBe("cmid-all");
  });

  // Codex review must-fix #5B: the lifecycle subscription must be
  // installed BEFORE `sendTurn` resolves. A fast turn/completed firing
  // between the RPC ack and the awaited resolution would otherwise leave
  // `sendingRef.current` stuck-true (chat input lock).
  it("onComplete fires even when turn/completed arrives before sendTurn resolves", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    const onComplete = vi.fn();

    let lifecycleHandler:
      | ((e: { turn_id: string; reason?: string; error?: unknown }) => void)
      | undefined;
    (bridge.onTurnLifecycle as ReturnType<typeof vi.fn>).mockImplementation(
      (h: (e: { turn_id: string; reason?: string; error?: unknown }) => void) => {
        lifecycleHandler = h;
        return () => {
          lifecycleHandler = undefined;
        };
      },
    );

    let resolveSendTurn: (() => void) | null = null;
    (bridge.sendTurn as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<{ accepted: true }>((res) => {
          resolveSendTurn = () => res({ accepted: true });
        }),
    );

    sendMessage({
      sessionId: SESSION,
      text: "fast",
      media: [],
      clientMessageId: "cmid-fast",
      onComplete,
    });

    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(lifecycleHandler).toBeDefined();

    // Fire turn/completed BEFORE sendTurn resolves.
    lifecycleHandler?.({ turn_id: "cmid-fast", reason: "stop" });
    expect(onComplete).toHaveBeenCalledTimes(1);

    // Now let sendTurn resolve. onComplete must NOT fire a second time.
    resolveSendTurn?.();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  // Codex review must-fix #5B: an RPC failure must also fire onComplete.
  it("onComplete fires when bridge.sendTurn rejects", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    const onComplete = vi.fn();

    (bridge.sendTurn as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.reject(new Error("rpc-broken")),
    );

    sendMessage({
      sessionId: SESSION,
      text: "boom",
      media: [],
      clientMessageId: "cmid-rpcfail",
      onComplete,
    });

    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(onComplete).toHaveBeenCalledTimes(1);
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].pendingAssistant).toBeNull();
    expect(threads[0].responses[0]?.status).toBe("error");
  });

  // M10 follow-up Bug B: 3 rapid sends serialise behind the prior turn's
  // lifecycle event before the next `bridge.sendTurn` issues.
  it("serialises 3 rapid sends per session, awaiting prior turn lifecycle", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);

    let lifecycleHandler:
      | ((e: { turn_id: string; reason?: string; error?: unknown }) => void)
      | undefined;
    (bridge.onTurnLifecycle as ReturnType<typeof vi.fn>).mockImplementation(
      (h: (e: { turn_id: string; reason?: string; error?: unknown }) => void) => {
        lifecycleHandler = h;
        return () => {
          lifecycleHandler = undefined;
        };
      },
    );

    sendMessage({
      sessionId: SESSION,
      text: "Q1",
      media: [],
      clientMessageId: "cmid-Q1",
    });
    sendMessage({
      sessionId: SESSION,
      text: "Q2",
      media: [],
      clientMessageId: "cmid-Q2",
    });
    sendMessage({
      sessionId: SESSION,
      text: "Q3",
      media: [],
      clientMessageId: "cmid-Q3",
    });

    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith(
      "cmid-Q1",
      [{ kind: "text", text: "Q1" }],
      undefined,
    );

    lifecycleHandler?.({ turn_id: "cmid-Q1", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith(
      "cmid-Q2",
      [{ kind: "text", text: "Q2" }],
      undefined,
    );

    lifecycleHandler?.({ turn_id: "cmid-Q2", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(3);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith(
      "cmid-Q3",
      [{ kind: "text", text: "Q3" }],
      undefined,
    );
  });

  // Codex P2 round 7 (M10 follow-up Bug B): a `bridge.sendTurn`
  // resolution of `{ accepted: false }` finalises the bubble inline so
  // the chain advances immediately and the next send proceeds.
  it("releases the queue when bridge.sendTurn resolves accepted: false", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);

    (bridge.sendTurn as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ accepted: false }),
    );

    const onComplete1 = vi.fn();
    const onComplete2 = vi.fn();

    sendMessage({
      sessionId: SESSION,
      text: "Q1 server-rejects",
      media: [],
      clientMessageId: "cmid-rejected",
      onComplete: onComplete1,
    });
    sendMessage({
      sessionId: SESSION,
      text: "Q2 follow-up",
      media: [],
      clientMessageId: "cmid-followup",
      onComplete: onComplete2,
    });

    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(onComplete1).toHaveBeenCalledTimes(1);
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.find((t) => t.id === "cmid-rejected")?.responses[0].status).toBe(
      "error",
    );
  });

  // Codex P2 round 4 (M10 follow-up Bug B): the user message must be
  // mirrored before subsequent sends process. Issue #109.1 reordered the
  // mirror to run AFTER `startBridgeForSession` resolves (so a failed
  // start cannot orphan a bubble); the queue chain entry is still
  // installed synchronously so per-session FIFO ordering survives.
  it("mirrors queued v1 user messages once the bridge has confirmed start", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);

    let lifecycleHandler:
      | ((e: { turn_id: string; reason?: string; error?: unknown }) => void)
      | undefined;
    (bridge.onTurnLifecycle as ReturnType<typeof vi.fn>).mockImplementation(
      (h: (e: { turn_id: string; reason?: string; error?: unknown }) => void) => {
        lifecycleHandler = h;
        return () => {
          lifecycleHandler = undefined;
        };
      },
    );

    sendMessage({
      sessionId: SESSION,
      text: "Q1",
      media: [],
      clientMessageId: "cmid-Q1",
    });
    sendMessage({
      sessionId: SESSION,
      text: "Q2",
      media: [],
      clientMessageId: "cmid-Q2",
    });

    // After the bridge-start await resolves and the chain advances Q1
    // through to its sendTurn, the Q1 mirror is present and Q2 is
    // parked behind the lifecycle gate.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    let threads = ThreadStore.getThreads(SESSION);
    expect(threads.map((t) => t.id)).toEqual(["cmid-Q1"]);
    expect(threads[0].userMsg.text).toBe("Q1");
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith(
      "cmid-Q1",
      [{ kind: "text", text: "Q1" }],
      undefined,
    );

    lifecycleHandler?.({ turn_id: "cmid-Q1", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
    threads = ThreadStore.getThreads(SESSION);
    expect(threads.map((t) => t.id)).toEqual(["cmid-Q1", "cmid-Q2"]);
    expect(threads[1].userMsg.text).toBe("Q2");
  });

  // Codex P2 round 3 (M10 follow-up Bug B): a throwing `onComplete`
  // callback must NOT wedge the per-session queue.
  it("releases the queue even when the onComplete callback throws", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);

    let lifecycleHandler:
      | ((e: { turn_id: string; reason?: string; error?: unknown }) => void)
      | undefined;
    (bridge.onTurnLifecycle as ReturnType<typeof vi.fn>).mockImplementation(
      (h: (e: { turn_id: string; reason?: string; error?: unknown }) => void) => {
        lifecycleHandler = h;
        return () => {
          lifecycleHandler = undefined;
        };
      },
    );

    const onCompleteThrowing = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const onCompleteFollowup = vi.fn();

    sendMessage({
      sessionId: SESSION,
      text: "Q1",
      media: [],
      clientMessageId: "cmid-Q1",
      onComplete: onCompleteThrowing,
    });
    sendMessage({
      sessionId: SESSION,
      text: "Q2",
      media: [],
      clientMessageId: "cmid-Q2",
      onComplete: onCompleteFollowup,
    });

    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);

    expect(() =>
      lifecycleHandler?.({ turn_id: "cmid-Q1", reason: "stop" }),
    ).toThrow("subscriber blew up");
    expect(onCompleteThrowing).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith(
      "cmid-Q2",
      [{ kind: "text", text: "Q2" }],
      undefined,
    );
  });

  // Codex NIT I rewrite: when the bridge transitions to `closed`
  // mid-Q1, Q1's lifecycle gate must release immediately so the chain
  // can advance. The pre-fix test then asserted Q2 reused the SAME
  // closed mock bridge to re-issue `sendTurn` — that's only possible
  // because `__setActiveBridgeForTest` keeps the runtime registry's
  // `connectionState` stuck at "connected" regardless of what the
  // bridge's own state subscriber sees. Production runs a different
  // path: `getActiveBridge` reflects the live `connectionState`, and
  // `startBridgeForSession` tears down a same-scope bridge whose
  // state has gone terminal (issue #109.4). So Q2 either:
  //   (a) finalizes immediately because the bridge is gone, or
  //   (b) reaches `sendTurn` on a FRESH bridge (a `restartBridge`-
  //       equivalent path), not on the closed one.
  //
  // To make this assertable in the harness, switch the runtime
  // registry into `connectionState: "closed"` right after the
  // state-transition. Then Q2's `startBridgeForSession` call sees
  // the terminal state and would normally tear down + start fresh —
  // since there's no real WS in the harness, the second start path
  // surfaces as a `bridge start failed` warning, `onComplete2` fires,
  // and the original mock bridge's `sendTurn` is NOT called a second
  // time. Assert that contract.
  it("on bridge `closed`: Q1's gate releases and Q2 does NOT reuse the closed bridge", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);

    let stateHandler: ((s: string) => void) | undefined;
    (bridge.onConnectionStateChange as ReturnType<typeof vi.fn>).mockImplementation(
      (h: (s: string) => void) => {
        stateHandler = h;
        return () => {
          stateHandler = undefined;
        };
      },
    );

    const onComplete1 = vi.fn();
    const onComplete2 = vi.fn();

    sendMessage({
      sessionId: SESSION,
      text: "Q1",
      media: [],
      clientMessageId: "cmid-Q1",
      onComplete: onComplete1,
    });
    sendMessage({
      sessionId: SESSION,
      text: "Q2",
      media: [],
      clientMessageId: "cmid-Q2",
      onComplete: onComplete2,
    });

    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(stateHandler).toBeDefined();

    // Bridge teardown: connection state goes to `closed`. The Q1
    // lifecycle gate must release WITHOUT waiting for `turn/completed`
    // (codex P2 round 2 contract).
    stateHandler?.("closed");
    expect(onComplete1).toHaveBeenCalledTimes(1);

    // Reflect the same closed state into the runtime registry — this
    // is what production wires up automatically through the runtime's
    // own `onConnectionStateChange` subscriber. The test harness's
    // `__setActiveBridgeForTest` doesn't, so we drive it explicitly to
    // exercise the post-closed `startBridgeForSession` path.
    __setActiveBridgeForTest(SESSION, bridge, undefined, "closed");

    // The post-closed `startBridgeForSession` tears down the active
    // bridge and creates a fresh one via `createUiProtocolBridge`. In
    // production that's a real bridge against a real WS; in this
    // harness we install a factory that rejects `start()` so the
    // bridge-start branch in `enqueueSendV1` finalises Q2 immediately
    // and onComplete2 fires. (Without the override the fresh real
    // bridge would block on a never-resolving WS in jsdom.)
    __bridgeFactoryOverride.current = () => ({
      start: vi.fn(async () => {
        throw new Error("fresh bridge: jsdom has no live WS");
      }),
      stop: vi.fn(async () => {}),
      sendTurn: vi.fn(),
      interruptTurn: vi.fn(),
      respondToApproval: vi.fn(),
      hydrateSession: vi.fn(async () => null),
      callMethod: vi.fn(),
      onMessageDelta: vi.fn(() => () => {}),
      onMessagePersisted: vi.fn(() => () => {}),
      onSpawnComplete: vi.fn(() => () => {}),
      onTaskUpdated: vi.fn(() => () => {}),
      onTaskOutputDelta: vi.fn(() => () => {}),
      onTurnLifecycle: vi.fn(() => () => {}),
      onApprovalRequested: vi.fn(() => () => {}),
      onConnectionStateChange: vi.fn(() => () => {}),
      getConnectionState: vi.fn(() => "connected"),
      onWarning: vi.fn(() => () => {}),
      onSessionTitleUpdated: vi.fn(() => () => {}),
    });

    for (let i = 0; i < 12; i++) await Promise.resolve();

    // Production contract: Q2 must complete (so the composer's
    // sending lock clears) but the closed bridge MUST NOT see a
    // second `sendTurn`. With the harness driven into the closed
    // state, the bridge-start path tears down + restarts a fresh
    // bridge — and the fresh bridge's start-fail surfaces through
    // `enqueueSendV1`'s catch branch.
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(onComplete2).toHaveBeenCalledTimes(1);
  });
});
