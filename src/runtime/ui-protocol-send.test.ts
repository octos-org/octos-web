import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetThinkingStoreForTest,
  setThinkingEffort,
} from "@/store/thinking-store";
import {
  __resetSendQueueForTest,
  buildTurnStartExtras,
  interruptActiveTurn,
  sendMessage,
} from "./ui-protocol-send";
import {
  __resetUiProtocolRuntimeForTest,
  __setActiveBridgeForTest,
} from "./ui-protocol-runtime";
import * as UiProtocolRuntime from "./ui-protocol-runtime";
import {
  BridgeStartupError,
  type ProjectionTerminalEvent,
  type UiProtocolBridge,
} from "./ui-protocol-bridge";

const SESSION = "sess-send";

type TerminalHandler = Parameters<UiProtocolBridge["onProjectionTerminal"]>[0];

type TestBridge = UiProtocolBridge & {
  sendTurn: ReturnType<typeof vi.fn>;
  interruptTurn: ReturnType<typeof vi.fn>;
  onProjectionTerminal: ReturnType<typeof vi.fn>;
  onTurnLifecycle: ReturnType<typeof vi.fn>;
  onConnectionStateChange: ReturnType<typeof vi.fn>;
};

function makeBridge(): TestBridge {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendTurn: vi.fn(async () => ({ accepted: true })),
    interruptTurn: vi.fn(async () => ({ interrupted: true })),
    onProjectionTerminal: vi.fn(() => () => {}),
    onTurnLifecycle: vi.fn(() => () => {}),
    onConnectionStateChange: vi.fn(() => () => {}),
    getConnectionState: vi.fn(() => "connected"),
  } as unknown as TestBridge;
}

function captureTerminals(bridge: TestBridge): TerminalHandler[] {
  const handlers: TerminalHandler[] = [];
  bridge.onProjectionTerminal.mockImplementation((handler: TerminalHandler) => {
    handlers.push(handler);
    return () => {};
  });
  return handlers;
}

function terminal(
  clientMessageId: string,
  outcome: ProjectionTerminalEvent["outcome"] = "completed",
): ProjectionTerminalEvent {
  return {
    session_id: SESSION,
    thread_id: `thread-${clientMessageId}`,
    turn_id: clientMessageId,
    client_message_id: clientMessageId,
    outcome,
    ...(outcome === "errored"
      ? { error: { code: "provider_error", message: "Provider stopped." } }
      : {}),
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  __resetUiProtocolRuntimeForTest();
  __resetSendQueueForTest();
  __resetThinkingStoreForTest();
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetUiProtocolRuntimeForTest();
  __resetSendQueueForTest();
  __resetThinkingStoreForTest();
  window.localStorage.clear();
});

describe("buildTurnStartExtras", () => {
  const base = { sessionId: SESSION, text: "", media: [] as string[] };

  it("includes stored thinking effort in the canonical turn request", () => {
    setThinkingEffort(SESSION, "high");
    expect(buildTurnStartExtras(base)?.reasoning_effort).toBe("high");
  });

  it("includes media, topic, rewrite, and live-video fields when supplied", () => {
    expect(
      buildTurnStartExtras({
        ...base,
        historyTopic: "slides",
        requestText: "rewritten prompt",
        text: "shown prompt",
        media: ["/tmp/deck.png"],
        clientMessageId: "cmid-extras",
        liveVideo: true,
      }),
    ).toMatchObject({
      topic: "slides",
      rewrite_for: "cmid-extras",
      live_video: true,
      media: [
        {
          path: "/tmp/deck.png",
          mime: "application/octet-stream",
          size_bytes: 0,
        },
      ],
    });
  });

  it("omits an extras envelope for a plain send", () => {
    expect(buildTurnStartExtras(base)).toBeUndefined();
  });
});

describe("buildTurnStartExtras tool context", () => {
  const base = { sessionId: SESSION, text: "", media: [] as string[] };

  it("maps a Notebook send to the tool_context wire field", () => {
    expect(
      buildTurnStartExtras({ ...base, toolContext: "notebook" })?.tool_context,
    ).toBe("notebook");
  });

  it("keeps ordinary sends free of a tool context", () => {
    expect(buildTurnStartExtras({ ...base })).toBeUndefined();
    expect(
      buildTurnStartExtras({ ...base, liveVideo: true })?.tool_context,
    ).toBeUndefined();
  });

  it("preserves the context for attachment and retry/rewrite sends", () => {
    const attachment = buildTurnStartExtras({
      ...base,
      media: ["uploads/source.pdf"],
      toolContext: "notebook",
    });
    expect(attachment?.media).toHaveLength(1);
    expect(attachment?.tool_context).toBe("notebook");

    const rewrite = buildTurnStartExtras({
      ...base,
      text: "original",
      requestText: "edited",
      clientMessageId: "cmid-original",
      toolContext: "notebook",
    });
    expect(rewrite?.rewrite_for).toBe("cmid-original");
    expect(rewrite?.tool_context).toBe("notebook");
  });
});

describe("sendMessage canonical settlement", () => {
  it("preserves an actionable typed bridge-start failure for the ghost UI", async () => {
    const startupError = new BridgeStartupError(
      "timeout",
      "Check that Octos Core is running and that this page origin is allowed.",
    );
    vi.spyOn(UiProtocolRuntime, "startBridgeForSession").mockRejectedValueOnce(
      startupError,
    );
    const onError = vi.fn();
    const onComplete = vi.fn();

    sendMessage({
      sessionId: SESSION,
      text: "hello",
      media: [],
      clientMessageId: "cmid-startup-failure",
      onError,
      onComplete,
    });
    await flush();

    expect(onError).toHaveBeenCalledWith(startupError);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("sends through the bridge and subscribes only to canonical terminals", async () => {
    const bridge = makeBridge();
    const terminals = captureTerminals(bridge);
    __setActiveBridgeForTest(SESSION, bridge);

    sendMessage({
      sessionId: SESSION,
      text: "hello",
      media: [],
      clientMessageId: "cmid-send",
    });
    await flush();

    expect(bridge.sendTurn).toHaveBeenCalledWith(
      "cmid-send",
      [{ kind: "text", text: "hello" }],
      undefined,
    );
    expect(bridge.onProjectionTerminal).toHaveBeenCalledTimes(1);
    expect(bridge.onTurnLifecycle).not.toHaveBeenCalled();

    terminals[0]?.(terminal("cmid-send"));
  });

  it("surfaces an errored canonical terminal through the ghost callback", async () => {
    const bridge = makeBridge();
    const terminals = captureTerminals(bridge);
    __setActiveBridgeForTest(SESSION, bridge);
    const onError = vi.fn();
    const onComplete = vi.fn();

    sendMessage({
      sessionId: SESSION,
      text: "canonical failure",
      media: [],
      clientMessageId: "cmid-error",
      onError,
      onComplete,
    });
    await flush();
    terminals[0]?.(terminal("cmid-error", "errored"));

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Provider stopped." }),
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("settles once when a canonical terminal arrives before turn/start resolves", async () => {
    const bridge = makeBridge();
    const terminals = captureTerminals(bridge);
    __setActiveBridgeForTest(SESSION, bridge);
    const onComplete = vi.fn();
    let resolveTurn: (() => void) | undefined;
    bridge.sendTurn.mockImplementation(
      () =>
        new Promise<{ accepted: true }>((resolve) => {
          resolveTurn = () => resolve({ accepted: true });
        }),
    );

    sendMessage({
      sessionId: SESSION,
      text: "fast terminal",
      media: [],
      clientMessageId: "cmid-fast",
      onComplete,
    });
    await flush();
    terminals[0]?.(terminal("cmid-fast"));
    expect(onComplete).toHaveBeenCalledTimes(1);

    resolveTurn?.();
    await flush();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("serializes queued sends until each canonical terminal", async () => {
    const bridge = makeBridge();
    const terminals = captureTerminals(bridge);
    __setActiveBridgeForTest(SESSION, bridge);

    for (const clientMessageId of ["cmid-Q1", "cmid-Q2", "cmid-Q3"]) {
      sendMessage({
        sessionId: SESSION,
        text: clientMessageId,
        media: [],
        clientMessageId,
      });
    }
    await flush();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(1);
    expect(bridge.sendTurn).toHaveBeenLastCalledWith(
      "cmid-Q1",
      [{ kind: "text", text: "cmid-Q1" }],
      undefined,
    );

    terminals[0]?.(terminal("cmid-Q1"));
    await flush();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);

    terminals[1]?.(terminal("cmid-Q2"));
    await flush();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(3);

    terminals[2]?.(terminal("cmid-Q3"));
  });

  it("releases the queue and reports a rejected turn/start", async () => {
    const bridge = makeBridge();
    const terminals = captureTerminals(bridge);
    __setActiveBridgeForTest(SESSION, bridge);
    bridge.sendTurn
      .mockResolvedValueOnce({ accepted: false })
      .mockResolvedValueOnce({ accepted: true });
    const onError = vi.fn();

    sendMessage({
      sessionId: SESSION,
      text: "rejected",
      media: [],
      clientMessageId: "cmid-rejected",
      onError,
    });
    sendMessage({
      sessionId: SESSION,
      text: "followup",
      media: [],
      clientMessageId: "cmid-followup",
    });
    await flush();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "The server rejected this turn." }),
    );
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);
    terminals[1]?.(terminal("cmid-followup"));
  });

  it("releases a queued replacement after an interrupt", async () => {
    const bridge = makeBridge();
    const terminals = captureTerminals(bridge);
    __setActiveBridgeForTest(SESSION, bridge);

    sendMessage({
      sessionId: SESSION,
      text: "first",
      media: [],
      clientMessageId: "cmid-first",
    });
    sendMessage({
      sessionId: SESSION,
      text: "replacement",
      media: [],
      clientMessageId: "cmid-replacement",
    });
    await flush();

    await expect(
      interruptActiveTurn({ sessionId: SESSION, turnId: "cmid-first" }),
    ).resolves.toBe(true);
    await flush();
    expect(bridge.sendTurn).toHaveBeenCalledTimes(2);

    terminals[1]?.(terminal("cmid-replacement"));
  });
});
