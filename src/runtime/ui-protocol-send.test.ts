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
import { sendMessage } from "./ui-protocol-send";
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
  ThreadStore.__resetForTests();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  __resetUiProtocolRuntimeForTest();
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

  it("falls back to the legacy bridge when no active bridge is registered", () => {
    sendMessage({
      sessionId: SESSION,
      text: "hi",
      media: [],
      clientMessageId: "cmid-fallback",
    });
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
    await Promise.resolve();
    await Promise.resolve();
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
    // Flush enough microtasks for the awaited sendTurn → finally block
    // to install the lifecycle subscription. Six ticks is comfortably
    // beyond what the chain needs (2-3 microtasks) but kept low to
    // avoid masking a hung promise.
    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(lifecycleHandler).toBeDefined();
    // A different turn's completion must not fire onComplete.
    lifecycleHandler?.({ turn_id: "other", reason: "stop" });
    expect(onComplete).not.toHaveBeenCalled();

    lifecycleHandler?.({ turn_id: "cmid-complete", reason: "stop" });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
