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
    expect(bridge.sendTurn).toHaveBeenLastCalledWith(
      "cmid-Q1",
      [{ kind: "text", text: "Q1" }],
      undefined,
    );

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
    expect(bridge.sendTurn).toHaveBeenLastCalledWith(
      "cmid-Q2",
      [{ kind: "text", text: "Q2" }],
      undefined,
    );
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
