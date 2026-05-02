/**
 * ui-protocol-runtime unit tests (Phase C-2, codex must-fix #4).
 *
 * Coverage:
 *   - rapid `startBridgeForSession(A)` then `startBridgeForSession(B)` does
 *     not leak bridges and does not let an older start overwrite a newer
 *     one's `active` slot when its `start()` resolves late
 *   - `stopActiveBridge` while a `start()` is in-flight: the in-flight
 *     start recognizes itself as superseded and stops its orphan bridge
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { createBridgeSpy } = vi.hoisted(() => ({
  createBridgeSpy: vi.fn(),
}));

vi.mock("./ui-protocol-bridge", async () => {
  const actual =
    await vi.importActual<typeof import("./ui-protocol-bridge")>(
      "./ui-protocol-bridge",
    );
  return {
    ...actual,
    createUiProtocolBridge: createBridgeSpy,
  };
});

import {
  __resetUiProtocolRuntimeForTest,
  getActiveBridge,
  startBridgeForSession,
  stopActiveBridge,
} from "./ui-protocol-runtime";
import type { UiProtocolBridge } from "./ui-protocol-bridge";

interface DeferredBridge {
  bridge: UiProtocolBridge;
  resolveStart: () => void;
  rejectStart: (err: Error) => void;
  startCalls: number;
  stopCalls: number;
}

function makeDeferredBridge(): DeferredBridge {
  let resolveStart: () => void = () => {};
  let rejectStart: (err: Error) => void = () => {};
  const startPromise = new Promise<void>((res, rej) => {
    resolveStart = res;
    rejectStart = rej;
  });
  let startCalls = 0;
  let stopCalls = 0;
  const bridge: UiProtocolBridge = {
    start: vi.fn(async () => {
      startCalls++;
      await startPromise;
    }),
    stop: vi.fn(async () => {
      stopCalls++;
    }),
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
  };
  return {
    bridge,
    resolveStart: () => resolveStart(),
    rejectStart: (err) => rejectStart(err),
    get startCalls() {
      return startCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
  };
}

beforeEach(() => {
  createBridgeSpy.mockReset();
  __resetUiProtocolRuntimeForTest();
});

afterEach(() => {
  __resetUiProtocolRuntimeForTest();
});

describe("startBridgeForSession race safety", () => {
  it("a stale start whose handshake resolves AFTER a newer start does not overwrite the newer bridge", async () => {
    const a = makeDeferredBridge();
    const b = makeDeferredBridge();
    createBridgeSpy.mockReturnValueOnce(a.bridge).mockReturnValueOnce(b.bridge);

    // Kick off A; start() is pending. Active stays null because we haven't
    // published yet.
    const startA = startBridgeForSession("sess-A");
    // The runtime's startBridgeForSession is sync until `await
    // bridge.start()`, so getActiveBridge sees no live entry yet.
    expect(getActiveBridge("sess-A")).toBeNull();

    // Now kick off B. Because `active` is still null (A never finished),
    // B is a fresh start — its own generation. (The `active != null`
    // branch in startBridgeForSession is skipped when the prior call is
    // mid-handshake; the generation counter is what protects us.)
    const startB = startBridgeForSession("sess-B");

    // Resolve B first. It should publish.
    b.resolveStart();
    await startB;
    expect(getActiveBridge("sess-B")).toBe(b.bridge);

    // Now resolve A. A is stale — it must NOT overwrite active, and it
    // must stop its orphan bridge.
    a.resolveStart();
    await expect(startA).rejects.toThrow(/superseded/);
    expect(a.stopCalls).toBe(1);

    // Active is still B.
    expect(getActiveBridge("sess-B")).toBe(b.bridge);
    expect(getActiveBridge("sess-A")).toBeNull();
  });

  it("an in-flight start that gets stopped recognizes itself as superseded", async () => {
    const a = makeDeferredBridge();
    createBridgeSpy.mockReturnValueOnce(a.bridge);

    const startA = startBridgeForSession("sess-A");
    // The runtime hasn't published `active` yet (await pending), so
    // stopActiveBridge is a no-op on the registry but bumps the
    // generation counter — that's the supersede signal.
    await stopActiveBridge();
    a.resolveStart();
    await expect(startA).rejects.toThrow(/superseded/);
    expect(a.stopCalls).toBe(1);
    expect(getActiveBridge("sess-A")).toBeNull();
  });

  it("idempotent same-scope re-entry returns the existing bridge", async () => {
    const a = makeDeferredBridge();
    createBridgeSpy.mockReturnValueOnce(a.bridge);
    const startA = startBridgeForSession("sess-A");
    a.resolveStart();
    const bridge = await startA;
    expect(bridge).toBe(a.bridge);

    // Second call with the same scope: must NOT spin up a second bridge.
    const second = await startBridgeForSession("sess-A");
    expect(second).toBe(a.bridge);
    expect(createBridgeSpy).toHaveBeenCalledTimes(1);
  });
});
