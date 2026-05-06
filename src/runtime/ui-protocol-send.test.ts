/**
 * ui-protocol-send unit tests (Phase C-2, issue #68).
 *
 * Coverage:
 *   - flag-OFF: delegates to the legacy SSE bridge unchanged
 *   - flag-ON with no active bridge: falls back to legacy so the user
 *     message is never lost on a pre-mount race
 *   - flag-ON with active bridge: dispatches via bridge.sendTurn and
 *     mirrors the user message into the thread store
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Hoisted mocks: vi.mock factories cannot reference module-scoped vars
// directly, so we expose the spy through vi.hoisted so the factory can
// import it. This is the standard vitest hoisting pattern.
const { legacySendSpy } = vi.hoisted(() => ({
  legacySendSpy: vi.fn(),
}));

vi.mock("./sse-bridge", () => ({
  sendMessage: legacySendSpy,
}));

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
  legacySendSpy.mockReset();
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

describe("sendMessage flag-OFF preservation", () => {
  it("flag-OFF delegates to the legacy SSE sendMessage unchanged", () => {
    const opts = {
      sessionId: SESSION,
      text: "hi",
      media: [] as string[],
      clientMessageId: "cmid-flag-off",
    };
    sendMessage(opts);
    expect(legacySendSpy).toHaveBeenCalledTimes(1);
    expect(legacySendSpy).toHaveBeenCalledWith(opts);
    // No thread is created on the v1 store path because the legacy
    // bridge is the one that mirrors into ThreadStore (flag-gated
    // internally by the v2 thread-store flag).
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(0);
  });
});

describe("sendMessage flag-ON path", () => {
  beforeEach(() => {
    window.localStorage.setItem("chat_app_ui_v1", "1");
  });

  it("falls back to the legacy bridge when no active bridge is registered", async () => {
    sendMessage({
      sessionId: SESSION,
      text: "hi",
      media: [],
      clientMessageId: "cmid-fallback",
    });
    // Bug B per-session queue: legacy fallback runs after `await prev`
    // so the synchronous spy assertion gains 2-3 microtask ticks.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(legacySendSpy).toHaveBeenCalledTimes(1);
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
    // The v1 path is async; let microtasks settle so the awaited
    // sendTurn invocation has been registered before we assert.
    // Bug B's per-session turn queue adds 2-3 microtask ticks (await
    // prev → await sendMessageV1 entry) on top of the legacy chain.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledWith("cmid-on", [
      { kind: "text", text: "hello" },
    ]);
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].userMsg.text).toBe("hello");
    expect(threads[0].id).toBe("cmid-on");
    // Legacy SSE sender must NOT have been invoked when the v1 path
    // owned the turn.
    expect(legacySendSpy).not.toHaveBeenCalled();
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
    // Flush enough microtasks for the per-session queue tail to settle,
    // then for the awaited sendTurn → finally block to install the
    // lifecycle subscription. The Bug B turn-queue adds 2-3 ticks on top
    // of the original chain (await prev, await sendMessageV1), so we
    // bumped from 6 to 12 — still tightly bounded so a hung promise still
    // surfaces as a failure.
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(lifecycleHandler).toBeDefined();
    // A different turn's completion must not fire onComplete.
    lifecycleHandler?.({ turn_id: "other", reason: "stop" });
    expect(onComplete).not.toHaveBeenCalled();

    lifecycleHandler?.({ turn_id: "cmid-complete", reason: "stop" });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  // Codex review must-fix #5A: media-bearing turns must NOT silently
  // drop on the v1 path (TurnStartInput.kind === "text" only). Falling
  // back to legacy keeps voice/image uploads working under the flag.
  it("falls back to legacy when media is present", async () => {
    const bridge = makeBridge();
    __setActiveBridgeForTest(SESSION, bridge);
    sendMessage({
      sessionId: SESSION,
      text: "with image",
      media: ["/tmp/foo.png"],
      clientMessageId: "cmid-media",
    });
    // Bug B per-session queue: legacy fallback runs after `await prev`.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(legacySendSpy).toHaveBeenCalledTimes(1);
    expect(bridge.sendTurn).not.toHaveBeenCalled();
    // The thread store must NOT be pre-populated by the v1 sync mirror —
    // the legacy bridge handles its own ThreadStore mirroring for
    // media (gated by isThreadStoreEnabled()), and duplicating it here
    // would double-thread.
    expect(ThreadStore.getThreads(SESSION)).toHaveLength(0);
  });

  // Codex review must-fix #5A: requestText !== text means a /command
  // rewrite. Legacy posts requestText to /api/chat; the v1 path only
  // takes a plain text input. Fall back so the rewrite isn't silently
  // dropped.
  it("falls back to legacy when requestText differs from text", async () => {
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
    expect(legacySendSpy).toHaveBeenCalledTimes(1);
    expect(bridge.sendTurn).not.toHaveBeenCalled();
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

    // Let the sync portion of sendMessageV1 run. The lifecycle
    // subscription must be installed BEFORE the await on sendTurn so the
    // handler is live now. Bug B's turn-queue adds 2-3 microtask ticks
    // on top of the original chain.
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

  // Codex review must-fix #5B: an RPC failure (network drop, server
  // error) must also fire onComplete so the chat input lock clears
  // instead of spinning forever.
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

    // Bug B turn-queue adds extra ticks on top of the original chain.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(onComplete).toHaveBeenCalledTimes(1);
    // The thread should be marked errored, not stuck pending.
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads).toHaveLength(1);
    expect(threads[0].pendingAssistant).toBeNull();
    expect(threads[0].responses[0]?.status).toBe("error");
  });

  // M10 follow-up Bug B: the WS `turn/start` handler enforces "one turn at
  // a time" per session — a second `turn/start` arriving while the
  // previous turn's foreground phase is still running is REJECTED with
  // `"a turn is already running for this session"`. The legacy SSE path
  // hid this from the SPA because `/api/chat` queues server-side; the v1
  // path doesn't, so the client must serialise sends per session.
  //
  // This test asserts that 3 rapid `sendMessage` calls (the
  // `live-overflow-stress` failure shape) issue `bridge.sendTurn`
  // serially: each call waits for the prior turn's
  // `turn/completed`/`turn/error` lifecycle event before its own RPC
  // fires. Without serialisation, all 3 issue concurrently and the
  // server rejects 2 of them, dropping 2 of 3 user prompts on the floor.
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

    // After the queue settles, only ONE bridge.sendTurn (Q1) must have
    // fired. Q2 and Q3 are blocked waiting for Q1's turn/completed.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith("cmid-Q1", [
      { kind: "text", text: "Q1" },
    ]);

    // Fire turn/completed for Q1. Q2's sendTurn must follow.
    lifecycleHandler?.({ turn_id: "cmid-Q1", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith("cmid-Q2", [
      { kind: "text", text: "Q2" },
    ]);

    // Q2 lifecycle → Q3 fires.
    lifecycleHandler?.({ turn_id: "cmid-Q2", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(3);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith("cmid-Q3", [
      { kind: "text", text: "Q3" },
    ]);
  });

  // Codex P2 round 4 (M10 follow-up Bug B): the user message must be
  // mirrored into ThreadStore SYNCHRONOUSLY, before the per-session
  // queue gate. Pre-fix, `addUserMessage` ran inside `sendMessageV1`
  // AFTER `await prev`, so a queued prompt was invisible until the
  // prior turn drained — and the user's input field had already
  // cleared, making the prompt feel lost.
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

    // After exactly one microtask tick — well before Q1's lifecycle
    // would unblock Q2's `bridge.sendTurn` — both user bubbles must
    // already be in the thread store.
    await Promise.resolve();
    const threads = ThreadStore.getThreads(SESSION);
    expect(threads.map((t) => t.id)).toEqual(["cmid-Q1", "cmid-Q2"]);
    expect(threads[0].userMsg.text).toBe("Q1");
    expect(threads[1].userMsg.text).toBe("Q2");
    // Only Q1's bridge.sendTurn fired so far — Q2 is still queued.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith("cmid-Q1", [
      { kind: "text", text: "Q1" },
    ]);

    lifecycleHandler?.({ turn_id: "cmid-Q1", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
  });

  // Codex P2 round 4 (M10 follow-up Bug B): a media-bearing prompt
  // queued behind an in-flight v1 turn must not overtake the v1 turn at
  // the server. Pre-fix, `sendMessage` short-circuited media sends to
  // the synchronous `legacySendMessage` path, so a "Q1 text → Q2
  // image" pair could arrive on the server in reverse order. Now every
  // v1 send (text, media, rewrite) funnels through `enqueueSendV1`,
  // and the legacy `/api/chat` for a fallback only runs after the
  // prior v1 turn's lifecycle.
  it("orders mixed text + media sends through the same per-session queue", async () => {
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

    // Q1: pure text → v1 path. Q2: text + media → legacy fallback.
    sendMessage({
      sessionId: SESSION,
      text: "Q1 text",
      media: [],
      clientMessageId: "cmid-Q1",
    });
    sendMessage({
      sessionId: SESSION,
      text: "Q2 with image",
      media: ["/tmp/foo.png"],
      clientMessageId: "cmid-Q2",
    });

    for (let i = 0; i < 12; i++) await Promise.resolve();
    // Q1's v1 sendTurn fired first; Q2's legacy fallback is parked.
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(legacySendSpy).not.toHaveBeenCalled();

    // Q1 completes → Q2's legacy /api/chat runs.
    lifecycleHandler?.({ turn_id: "cmid-Q1", reason: "stop" });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(legacySendSpy).toHaveBeenCalledTimes(1);
  });

  // Codex P2 round 3 (M10 follow-up Bug B): a throwing `onComplete`
  // callback must NOT wedge the per-session queue. Pre-fix, the
  // lifecycle promise never resolved because the throw unwound past
  // `releaseLifecycleGate` and every subsequent send blocked on the
  // 15-min safety timer.
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

    // Q1's lifecycle fires; its onComplete throws. The chain MUST still
    // advance — Q2's sendTurn must follow. The real bridge swallows
    // subscriber exceptions inside its `Subscribers.emit`; this mock
    // calls the handler directly so we catch the throw at the call
    // site to mirror the real-world contract.
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

  // Codex P2 round 2 (M10 follow-up Bug B): when the bridge is torn down
  // (user navigates away from the session/topic, runtime calls
  // `stopActiveBridge`), `bridge.stop()` clears `subTurnLifecycle`. The
  // `onTurnLifecycle` handler installed by the in-flight `sendMessageV1`
  // is dropped before the server ever emits `turn/completed`. Pre-fix,
  // the per-session queue would block subsequent sends for the 15-min
  // safety timer.
  //
  // The connection-state listener bridges this: as soon as the bridge
  // transitions to `"closed"`, the in-flight send forces release of the
  // lifecycle gate. Subsequent enqueued sends resume immediately
  // (falling through to legacy if the bridge is gone).
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

    // First send installs its lifecycle + state listeners.
    sendMessage({
      sessionId: SESSION,
      text: "Q1",
      media: [],
      clientMessageId: "cmid-Q1",
      onComplete: onComplete1,
    });
    // Second send queues behind Q1's lifecycle gate.
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

    // Q2 must now proceed. With the bridge already torn down /
    // unregistered, the v1 path falls back to legacy. The real legacy
    // SSE bridge fires `onComplete` on stream done — mirror that with
    // the spy mock so the queue-release tied to legacy completion
    // (codex round 5 P2) actually fires in the test, allowing a Q3
    // follow-up to proceed instead of parking on the 15-min safety
    // timer.
    legacySendSpy.mockImplementation((opts: SendOptions) => {
      // Microtask-defer onComplete so the queue advances after the
      // current await Promise.resolve() loop, not synchronously.
      Promise.resolve().then(() => opts.onComplete?.());
    });
    __resetUiProtocolRuntimeForTest(); // mirrors runtime stopping the bridge
    for (let i = 0; i < 12; i++) await Promise.resolve();
    // sendTurn count is unchanged — Q2 fell to legacy because the bridge
    // is no longer registered when its turn at the queue head arrived.
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    // Q3 follow-up: lands on legacy too (still no bridge). The queue
    // must have drained for this to fire.
    legacySendSpy.mockClear();
    legacySendSpy.mockImplementation((opts: SendOptions) => {
      Promise.resolve().then(() => opts.onComplete?.());
    });
    sendMessage({
      sessionId: SESSION,
      text: "Q3",
      media: [],
      clientMessageId: "cmid-Q3",
    });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(legacySendSpy).toHaveBeenCalled();
  });
});
