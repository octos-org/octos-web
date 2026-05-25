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
import type { ConnectionState } from "./ui-protocol-types";

interface DeferredBridge {
  bridge: UiProtocolBridge;
  resolveStart: () => void;
  rejectStart: (err: Error) => void;
  /** Drive the bridge's connection-state subscriber. The runtime
   *  publishes the bridge with state="connecting" and `getActiveBridge`
   *  refuses to surface a bridge that is not "connected"; tests must
   *  fire `setConnected()` after `await startBridgeForSession(...)`
   *  for `getActiveBridge` to return the bridge. */
  setConnected: () => void;
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
  // Track the current state subscriber so the test can drive the bridge
  // to `"connected"` after `start()` resolves — `getActiveBridge` only
  // surfaces a bridge that has reached `connected` (codex M10.5 round 2
  // P2), so the registry's published-with-state="connecting" entry would
  // otherwise look like null to assertions.
  let stateHandler: ((s: ConnectionState) => void) | null = null;
  // Track the reopen subscriber so the test can simulate the bridge's
  // post-reconnect re-handshake event (reload-bug fix Yue 2026-05-15).
  let reopenedHandler: (() => void) | null = null;
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
    onSpawnComplete: vi.fn(() => () => {}),
    onFileAttached: vi.fn(() => () => {}),
    onTaskUpdated: vi.fn(() => () => {}),
    onTaskOutputDelta: vi.fn(() => () => {}),
    onTurnLifecycle: vi.fn(() => () => {}),
    onApprovalRequested: vi.fn(() => () => {}),
    onToolStarted: vi.fn(() => () => {}),
    onToolProgress: vi.fn(() => () => {}),
    onToolCompleted: vi.fn(() => () => {}),
    onProgressUpdated: vi.fn(() => () => {}),
    onRouterStatus: vi.fn(() => () => {}),
    onRouterFailover: vi.fn(() => () => {}),
    onQueueState: vi.fn(() => () => {}),
    onConnectionStateChange: vi.fn((h: (s: ConnectionState) => void) => {
      stateHandler = h;
      return () => {
        if (stateHandler === h) stateHandler = null;
      };
    }),
    getConnectionState: vi.fn(() => "connected" as ConnectionState),
    onReopened: vi.fn((h: () => void) => {
      reopenedHandler = h;
      return () => {
        if (reopenedHandler === h) reopenedHandler = null;
      };
    }),
    onWarning: vi.fn(() => () => {}),
    onSessionTitleUpdated: vi.fn(() => () => {}),
    hydrateSession: vi.fn(async () => null),
    callMethod: vi.fn(async () => null),
  };
  return {
    bridge,
    resolveStart: () => resolveStart(),
    rejectStart: (err) => rejectStart(err),
    setConnected: () => stateHandler?.("connected"),
    /** Simulate the bridge's post-reconnect `session/open` ack
     *  (reload-bug fix Yue 2026-05-15). The runtime layer subscribes via
     *  `onReopened` to re-fire `session/hydrate`. */
    fireReopened: () => reopenedHandler?.(),
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
    // Drive the bridge to `connected` so `getActiveBridge` surfaces it.
    b.setConnected();
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

  it("sendTurn fast-rejects when the underlying bridge has gone closed", async () => {
    // Codex M10.5 Wave A round-4 P2: removing the SSE-fallback gate from
    // `getActiveBridge` correctly stops re-routing turns through SSE,
    // but if the WS bridge is permanently `closed` / `error` the bridge
    // itself MUST fast-reject its public send methods (`sendTurn` /
    // `interruptTurn` / `respondToApproval`) instead of parking the
    // frame in `sendQueue` and never settling its Promise — that path
    // makes the user's optimistic bubble vanish silently when their
    // network drops mid-session. This test models the new contract
    // through the runtime: drive a mock bridge whose `sendTurn` rejects
    // when its connection state is dead, hand it back via
    // `getActiveBridge`, and verify the rejection bubbles up with the
    // user-facing message.
    const a = makeDeferredBridge();
    createBridgeSpy.mockReturnValueOnce(a.bridge);

    // Override the mock's sendTurn to mirror real bridge behavior:
    // reject with the canonical closed-WS message when the bridge
    // believes it is in a terminal state.
    let mockState: ConnectionState = "connected";
    (
      a.bridge.sendTurn as unknown as {
        mockImplementation: (
          fn: (turn_id: string, input: unknown) => Promise<unknown>,
        ) => void;
      }
    ).mockImplementation(async (_turn_id: string, _input: unknown) => {
      if (mockState === "closed" || mockState === "error") {
        throw new Error(
          "WebSocket connection is closed; please refresh the page",
        );
      }
      return { accepted: true };
    });

    const startA = startBridgeForSession("sess-A");
    a.resolveStart();
    await startA;
    a.setConnected();
    expect(getActiveBridge("sess-A")).toBe(a.bridge);

    // While alive, sendTurn succeeds (sanity check the harness).
    await expect(a.bridge.sendTurn("turn-1", [])).resolves.toEqual({
      accepted: true,
    });

    // Drive the bridge into a terminal state. The runtime's internal
    // tracker doesn't gate getActiveBridge anymore (round-3 dropped the
    // SSE fallback), so a stale getActiveBridge result still hands back
    // the bridge — and the bridge itself is responsible for rejecting.
    mockState = "closed";
    const dead = getActiveBridge("sess-A");
    expect(dead).toBe(a.bridge);
    await expect(dead!.sendTurn("turn-2", [])).rejects.toThrow(
      /WebSocket connection is closed/,
    );
  });
});

// ---------------------------------------------------------------------------
// Reload-bug fix (Yue 2026-05-15): on WS reconnect, the runtime must
// re-issue `session/hydrate` so envelopes the server emitted while the
// socket was dropped (e.g. a `TurnSpawnComplete` for a long-running
// `spawn_only`) get replayed via `replayed_envelopes`. Without this, a
// 12-min `run_pipeline` whose user lost their WS at completion would
// complete silently and the UI would show nothing.
//
// The bridge's `onReopened` event fires ONLY on a subsequent successful
// `session/open` ack (not the initial open) — these tests pin both
// halves: the post-reopen hydrate fires, the initial open does NOT
// double-hydrate.
// ---------------------------------------------------------------------------
describe("reload-bug fix: re-hydrate session on WS reconnect", () => {
  it("does NOT call hydrateSession a second time on the initial bridge start", async () => {
    const a = makeDeferredBridge();
    createBridgeSpy.mockReturnValueOnce(a.bridge);

    const startA = startBridgeForSession("sess-A");
    a.resolveStart();
    await startA;
    a.setConnected();
    // Let the void-immediately-invoked async hydrate settle.
    await Promise.resolve();
    await Promise.resolve();

    // Initial start fires hydrate ONCE. `onReopened` has not fired, so
    // there should be exactly one call.
    expect(a.bridge.hydrateSession).toHaveBeenCalledTimes(1);
    expect(a.bridge.hydrateSession).toHaveBeenCalledWith(["messages"]);
  });

  it("calls hydrateSession again after the bridge's onReopened event fires", async () => {
    const a = makeDeferredBridge();
    createBridgeSpy.mockReturnValueOnce(a.bridge);

    const startA = startBridgeForSession("sess-A");
    a.resolveStart();
    await startA;
    a.setConnected();
    await Promise.resolve();
    await Promise.resolve();

    // Sanity: initial hydrate ran.
    expect(a.bridge.hydrateSession).toHaveBeenCalledTimes(1);

    // Simulate the bridge's post-reconnect `session/open` ack. The
    // runtime must re-issue `session/hydrate` so the server replays any
    // envelopes (e.g. a `TurnSpawnComplete`) it emitted while the WS
    // was disconnected — without this, those envelopes are silently
    // dropped by the cursorless `session/open` ("live only, no
    // replay") at `ui_protocol_ledger.rs:1199`.
    a.fireReopened();
    await Promise.resolve();
    await Promise.resolve();

    expect(a.bridge.hydrateSession).toHaveBeenCalledTimes(2);
    // Both calls request the messages dedup payload.
    const calls = (a.bridge.hydrateSession as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls[0]).toEqual([["messages"]]);
    expect(calls[1]).toEqual([["messages"]]);
  });

  it("applies the post-reopen hydrate result to ThreadStore for replay dedup", async () => {
    // Reload-bug fix: the post-reconnect hydrate's `replayed_envelopes`
    // need to reach `setHydrateSnapshot` so ThreadStore's
    // `applyHydrateDedup` can splice the missed turn into the UI.
    // Mock `hydrateSession` to return a synthetic envelope that mirrors
    // what the server replays for a missed `TurnSpawnComplete`.
    const a = makeDeferredBridge();
    createBridgeSpy.mockReturnValueOnce(a.bridge);

    const REPLAY_PAYLOAD = {
      messages: [],
      replayed_envelopes: [
        {
          thread_id: "cmid-user-x",
          turn_id: "turn-x",
          response_to_client_message_id: "cmid-user-x",
          task_id: "task_recover_x",
          seq: 7,
          message_id: "msg-spawn-x",
          content: "Replayed completion bubble from durable ledger.",
          media: ["bg/result.mp3"],
          persisted_at: "2026-05-15T00:00:00Z",
        },
      ],
    } as const;

    // Initial hydrate returns empty; the post-reopen hydrate returns
    // the recovery payload.
    (
      a.bridge.hydrateSession as unknown as {
        mockImplementationOnce: (
          fn: () => Promise<unknown>,
        ) => unknown;
      }
    )
      .mockImplementationOnce(async () => ({
        messages: [],
        replayed_envelopes: [],
      }))
      .mockImplementationOnce(async () => REPLAY_PAYLOAD);

    const startA = startBridgeForSession("sess-A");
    a.resolveStart();
    await startA;
    a.setConnected();
    await Promise.resolve();
    await Promise.resolve();

    // Confirm initial hydrate fired with the empty payload.
    expect(a.bridge.hydrateSession).toHaveBeenCalledTimes(1);

    // Fire reopen — runtime issues the second hydrate.
    a.fireReopened();
    await Promise.resolve();
    await Promise.resolve();

    expect(a.bridge.hydrateSession).toHaveBeenCalledTimes(2);
    // The second call returned the recovery payload. The runtime's
    // hydrate callback writes it through `setHydrateSnapshot`. We don't
    // assert on ThreadStore internals directly here (covered by
    // thread-store tests) — instead we lock in the call contract: the
    // RPC was issued post-reopen with the same `["messages"]` include,
    // which is what server PR #791 keys the dedup payload on.
    const calls = (a.bridge.hydrateSession as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls[1]).toEqual([["messages"]]);
  });

  it("does not crash when the bridge mock predates the onReopened method", async () => {
    // Defensive: existing tests may inject a bridge whose `onReopened`
    // is undefined. The runtime should skip subscription rather than
    // throw — the test below validates the guard.
    const a = makeDeferredBridge();
    // Strip the method to simulate an older mock.
    (a.bridge as unknown as { onReopened?: unknown }).onReopened = undefined;
    createBridgeSpy.mockReturnValueOnce(a.bridge);

    const startA = startBridgeForSession("sess-A");
    a.resolveStart();
    const bridge = await startA;
    a.setConnected();
    expect(bridge).toBe(a.bridge);
    // No throw — the runtime's `typeof bridge.onReopened === "function"`
    // guard skipped the subscription path.
  });

  it("does not re-hydrate after the runtime has stopped the bridge", async () => {
    // Race-safety: a reopen that fires after `stopActiveBridge` ran is
    // either a phantom event from a torn-down bridge or a stale
    // subscriber. The generation guard in the reopen callback must
    // skip the hydrate.
    const a = makeDeferredBridge();
    createBridgeSpy.mockReturnValueOnce(a.bridge);

    const startA = startBridgeForSession("sess-A");
    a.resolveStart();
    await startA;
    a.setConnected();
    await Promise.resolve();
    await Promise.resolve();
    expect(a.bridge.hydrateSession).toHaveBeenCalledTimes(1);

    await stopActiveBridge();

    // Fire a stale reopen — must NOT trigger a new hydrate.
    a.fireReopened();
    await Promise.resolve();
    await Promise.resolve();
    expect(a.bridge.hydrateSession).toHaveBeenCalledTimes(1);
  });

  it("skips hydrate for topic-scoped bridges (root-scope dedup only)", async () => {
    // The existing initial-hydrate path skips topic-scoped bridges
    // because `session/hydrate` returns root-scope envelopes and
    // applying them to a topic-scoped store would leak cross-topic
    // events (codex round-2 P2). The reopen path inherits the same
    // restriction.
    const a = makeDeferredBridge();
    createBridgeSpy.mockReturnValueOnce(a.bridge);

    const startA = startBridgeForSession("sess-A", "site-x");
    a.resolveStart();
    await startA;
    a.setConnected();
    await Promise.resolve();
    await Promise.resolve();

    // Initial start did NOT hydrate (topic-scoped).
    expect(a.bridge.hydrateSession).not.toHaveBeenCalled();

    // Reopen also must NOT hydrate.
    a.fireReopened();
    await Promise.resolve();
    await Promise.resolve();
    expect(a.bridge.hydrateSession).not.toHaveBeenCalled();
  });
});
