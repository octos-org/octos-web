/**
 * ui-protocol-send unit tests.
 *
 * M9-α-5/α-6 (ADR PR #830 / audit issue #845): the legacy SSE bridge has
 * been deleted; `/api/ui-protocol/ws` is the sole chat transport.
 *
 * Coverage:
 *   - active bridge: dispatches via `bridge.sendTurn` and mirrors the
 *     user message into the thread store
 *   - no active bridge: surfaces an error on the assistant bubble (no
 *     legacy fallback exists anymore)
 *   - media / requestText / topic-scoped sends: surface an error
 *     (`TurnStartInput` is text-only today; M9-β extension follow-up)
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
});

afterEach(() => {
  window.localStorage.clear();
  __resetUiProtocolRuntimeForTest();
  __resetSendQueueForTest();
});

describe("sendMessage", () => {
  it("errors the bubble when no active bridge is registered", async () => {
    const onComplete = vi.fn();
    sendMessage({
      sessionId: SESSION,
      text: "hi",
      media: [],
      clientMessageId: "cmid-no-bridge",
      onComplete,
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    // The user bubble was mirrored synchronously, then finalised as
    // errored when the gate cleared without an available bridge.
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("cmid-no-bridge");
    expect(threads[0].pendingAssistant).toBeNull();
    expect(threads[0].responses[0]?.status).toBe("error");
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
    expect(bridge.sendTurn).toHaveBeenCalledWith("cmid-on", [
      { kind: "text", text: "hello" },
    ]);
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
    expect(bridge.sendTurn).toHaveBeenCalledWith("cmid-ghost", [
      { kind: "text", text: "ghost" },
    ]);
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

  // M9-α-5/α-6: media-bearing turns no longer have a legacy SSE
  // fallback. The send surfaces an error instead of silently dropping;
  // the assistant bubble is finalised as errored and the queue advances.
  it("errors the bubble when media is present (WS path is text-only)", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    sendMessage({
      sessionId: SESSION,
      text: "with image",
      media: ["/tmp/foo.png"],
      clientMessageId: "cmid-media",
    });
    await Promise.resolve();
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(1);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).not.toHaveBeenCalled();
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads[0].responses[0]?.status).toBe("error");
  });

  // M9-α-5/α-6: `/queue interrupt` style rewrites also surface an error.
  it("errors the bubble when requestText differs from text", async () => {
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
    expect(bridge.sendTurn).not.toHaveBeenCalled();
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads[0].responses[0]?.status).toBe("error");
  });

  // M9-α-5/α-6: topic-scoped sends surface an error too.
  it("errors the bubble when historyTopic is set", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    sendMessage({
      sessionId: SESSION,
      historyTopic: "slides",
      text: "make a deck",
      media: [],
      clientMessageId: "cmid-topic",
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).not.toHaveBeenCalled();
    const threads = ThreadStore.getThreads(SESSION, "slides");
    expect(threads[0].responses[0]?.status).toBe("error");
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
    expect(bridge.sendTurn).toHaveBeenLastCalledWith("cmid-Q1", [
      { kind: "text", text: "Q1" },
    ]);

    lifecycleHandler?.({ turn_id: "cmid-Q1", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith("cmid-Q2", [
      { kind: "text", text: "Q2" },
    ]);

    lifecycleHandler?.({ turn_id: "cmid-Q2", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(3);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith("cmid-Q3", [
      { kind: "text", text: "Q3" },
    ]);
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
  // mirrored synchronously, before the per-session queue gate.
  it("mirrors a queued v1 user message synchronously, before the gate clears", async () => {
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

    await Promise.resolve();
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.map((t) => t.id)).toEqual(["cmid-Q1", "cmid-Q2"]);
    expect(threads[0].userMsg.text).toBe("Q1");
    expect(threads[1].userMsg.text).toBe("Q2");
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith("cmid-Q1", [
      { kind: "text", text: "Q1" },
    ]);

    lifecycleHandler?.({ turn_id: "cmid-Q1", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
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
    expect(bridge.sendTurn).toHaveBeenLastCalledWith("cmid-Q2", [
      { kind: "text", text: "Q2" },
    ]);
  });

  // Codex P2 round 2 (M10 follow-up Bug B): when the bridge transitions
  // to `closed`, the in-flight send forces the lifecycle gate to release
  // so subsequent sends drain.
  it("releases the per-session queue when the bridge transitions to closed", async () => {
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

    // Bridge teardown: connection state goes to `closed`. The lifecycle
    // gate must release WITHOUT waiting for `turn/completed`.
    stateHandler?.("closed");
    expect(onComplete1).toHaveBeenCalledTimes(1);

    // Q2 must now proceed. With the bridge unregistered, the v1 path
    // surfaces a "no bridge" error on the assistant bubble (the legacy
    // SSE fallback was deleted).
    __resetUiProtocolRuntimeForTest(); // mirrors runtime stopping the bridge
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(onComplete2).toHaveBeenCalledTimes(1);
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.find((t) => t.id === "cmid-Q2")?.responses[0].status).toBe(
      "error",
    );
  });
});
