import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createUiProtocolBridge } from "./ui-protocol-bridge";
import {
  parseProjectionEnvelopeV2,
  type ProjectionEnvelopeV2,
} from "./projection-envelope-v2";
import {
  __resetProjectionCacheForTesting,
  projectWithMetrics,
} from "../store/projection";
import type { Envelope } from "./ui-protocol-types";

const fixtureDirectory = resolve(__dirname, "fixtures/projection-envelope-v2");

const currentWireFixtureNames = [
  "user-message.json",
  "assistant-delta.json",
  "assistant-persisted-with-media.json",
  "tool-outcome.json",
  "terminal-error.json",
  "background-spawn-complete.json",
] as const;

type FixtureName =
  | (typeof currentWireFixtureNames)[number]
  | "reconnect-cursor.json";

function readFixture(name: FixtureName): unknown {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, name), "utf8")) as unknown;
}

function parseFixture(name: FixtureName): ProjectionEnvelopeV2 {
  const parsed = parseProjectionEnvelopeV2(readFixture(name));
  if (!parsed.ok) {
    throw new Error(`${name} did not decode: ${parsed.error.path} ${parsed.error.message}`);
  }
  return parsed.value;
}

function frameWithPayload(payload: unknown): unknown {
  const currentWire = readFixture("assistant-delta.json") as Record<string, unknown>;
  return { ...currentWire, payload };
}

class ReceiveOnlySocket {
  static instances: ReceiveOnlySocket[] = [];

  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = ReceiveOnlySocket.CONNECTING;
  readonly OPEN = ReceiveOnlySocket.OPEN;
  readonly CLOSING = ReceiveOnlySocket.CLOSING;
  readonly CLOSED = ReceiveOnlySocket.CLOSED;

  readyState = ReceiveOnlySocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    void url;
    ReceiveOnlySocket.instances.push(this);
  }

  send(data: string): void {
    void data;
  }

  close(): void {
    this.readyState = ReceiveOnlySocket.CLOSED;
  }

  open(): void {
    this.readyState = ReceiveOnlySocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(value: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
}

beforeEach(() => {
  ReceiveOnlySocket.instances = [];
  __resetProjectionCacheForTesting();
});

describe("projection-envelope v2 parser — current wire and v2 extension fixtures", () => {
  for (const fixtureName of currentWireFixtureNames) {
    it(`decodes the current cursor-absent wire fixture ${fixtureName}`, () => {
      const envelope = parseFixture(fixtureName);

      expect(envelope.session_id).toBe("session-capture-001");
      expect(envelope.seq).toBeGreaterThanOrEqual(1);
      expect(envelope.cursor).toBeUndefined();
    });
  }

  it("preserves the typed user-message root and its client id", () => {
    const envelope = parseFixture("user-message.json");

    expect(envelope).toMatchObject({
      topic: "planning",
      thread_id: "thread-capture-001",
      seq: 1,
      client_message_id: "cmid-capture-001",
      payload: {
        type: "user_message",
        data: {
          text: "Please turn this screenshot into an implementation plan.",
          files: [
            {
              path: "uploads/capture-001.png",
              mime: "image/png",
              size_bytes: 2048,
            },
          ],
        },
      },
    });
    expect(envelope.cursor).toBeUndefined();
  });

  it("preserves assistant delta and durable persisted media", () => {
    const delta = parseFixture("assistant-delta.json");
    const persisted = parseFixture("assistant-persisted-with-media.json");

    expect(delta.payload).toEqual({
      type: "assistant_delta",
      data: { text: "I will start by identifying the major flows." },
    });
    expect(persisted.payload).toMatchObject({
      type: "assistant_persisted",
      data: {
        text: "I found three implementation milestones.",
        meta: {
          message_id: "msg-capture-003",
          persisted_at: "2026-07-18T22:10:03Z",
          media: ["artifacts/implementation-plan.md"],
        },
      },
    });
  });

  it("preserves tool outcomes and a terminal error as separate typed payloads", () => {
    const toolOutcome = parseFixture("tool-outcome.json");
    const terminal = parseFixture("terminal-error.json");

    expect(toolOutcome.payload).toEqual({
      type: "tool_end",
      data: {
        tool_call_id: "call-capture-001",
        status: "error",
        error: "workspace access was denied",
      },
    });
    expect(terminal.payload).toMatchObject({
      type: "turn_completed",
      data: {
        status: "error",
        token_usage: { input_tokens: 120, output_tokens: 37 },
        error: {
          code: "runtime_error",
          message: "The model provider stopped the turn.",
          data: { retryable: true },
        },
      },
    });
  });

  it("also accepts the v2 reconnect cursor independently of the thread sequence", () => {
    const envelope = parseFixture("reconnect-cursor.json");

    expect(envelope.seq).toBe(1);
    expect(envelope.cursor).toEqual({
      stream: "session-capture-001",
      seq: 412,
    });
    expect(envelope.topic).toBeUndefined();
  });

  it("decodes a background spawn completion with its content and media", () => {
    const envelope = parseFixture("background-spawn-complete.json");

    expect(envelope.payload).toMatchObject({
      type: "background/spawn_complete",
      data: {
        task_id: "task-capture-001",
        tool_call_id: "call-capture-002",
        content: "The background analysis is ready.",
        media: ["artifacts/background-analysis.md"],
      },
    });
  });

  it("decodes the remaining canonical payload variants without a live route", () => {
    const cases = [
      {
        input: frameWithPayload({
          type: "reasoning_delta",
          data: { text: "I need to inspect the wire before changing it." },
        }),
        payload: {
          type: "reasoning_delta",
          data: { text: "I need to inspect the wire before changing it." },
        },
      },
      {
        input: frameWithPayload({
          type: "tool_start",
          data: {
            tool_call_id: "call-capture-start",
            name: "workspace.inspect",
            arguments: { depth: 2 },
          },
        }),
        payload: {
          type: "tool_start",
          data: {
            tool_call_id: "call-capture-start",
            name: "workspace.inspect",
            arguments: { depth: 2 },
          },
        },
      },
      {
        input: frameWithPayload({
          type: "tool_progress",
          data: {
            tool_call_id: "call-capture-progress",
            message: "Reading protocol definitions",
          },
        }),
        payload: {
          type: "tool_progress",
          data: {
            tool_call_id: "call-capture-progress",
            message: "Reading protocol definitions",
          },
        },
      },
      {
        input: frameWithPayload({
          type: "file_attached",
          data: {
            path: "artifacts/projection-plan.md",
            mime: "text/markdown",
            size_bytes: 512,
          },
        }),
        payload: {
          type: "file_attached",
          data: {
            path: "artifacts/projection-plan.md",
            mime: "text/markdown",
            size_bytes: 512,
          },
        },
      },
    ];

    for (const { input, payload } of cases) {
      expect(parseProjectionEnvelopeV2(input)).toMatchObject({
        ok: true,
        value: { payload },
      });
    }
  });

  it("is pure: parsing does not mutate a fixture and repeats deterministically", () => {
    const fixture = readFixture("assistant-persisted-with-media.json");
    const before = JSON.stringify(fixture);

    expect(parseProjectionEnvelopeV2(fixture)).toEqual(
      parseProjectionEnvelopeV2(fixture),
    );
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it("rejects the old zero-based sequence and a nested envelope shape", () => {
    const zeroBased = readFixture("user-message.json") as Record<string, unknown>;
    zeroBased.seq = 0;
    const zeroResult = parseProjectionEnvelopeV2(zeroBased);
    expect(zeroResult).toMatchObject({
      ok: false,
      error: { code: "invalid_field", path: "$.seq" },
    });

    const nested = { envelope: readFixture("user-message.json") };
    const nestedResult = parseProjectionEnvelopeV2(nested);
    expect(nestedResult).toMatchObject({
      ok: false,
      error: { code: "missing_field", path: "$.session_id" },
    });
  });
});

describe("projection-envelope v2 parser — shadow incompatibility guard", () => {
  it("documents that the legacy shadow decoder rejects the real flattened wire because it requires turn_id", async () => {
    // This is intentionally a receive-only characterization test. The Stage 0
    // parser above neither imports nor calls the bridge; this assertion pins
    // the known incompatibility: the shadow decoder requires its legacy
    // `turn_id`, while the real EnvelopeWire carries `thread_id`. A later
    // migration must explicitly replace the shadow path.
    const bridge = createUiProtocolBridge({
      origin: "https://test.local",
      getToken: () => "test-token",
      getProfileId: () => null,
      features: [],
      webSocketImpl: ReceiveOnlySocket as unknown as typeof WebSocket,
    });
    const warnings: string[] = [];
    bridge.onWarning((warning) => warnings.push(warning.reason));

    await bridge.start({});
    const socket = ReceiveOnlySocket.instances[0];
    if (!socket) throw new Error("test bridge did not create a socket");
    socket.open();

    for (const fixtureName of currentWireFixtureNames) {
      socket.receive({
        jsonrpc: "2.0",
        method: "projection/envelope",
        params: readFixture(fixtureName),
      });
    }

    expect(warnings).toEqual(
      currentWireFixtureNames.map(() => "invalid_event:projection/envelope"),
    );
    await bridge.stop();
  });

  it("documents the shadow projection's separate seq-0 assumption", () => {
    // The old pure projection initializes `expectedNextSeq` to zero. Feeding
    // it a valid server frame beginning at seq=1 only buffers that root and
    // leaves the user view empty. This test is a regression guard, not a
    // dependency of the Stage 0 parser or any production receive path.
    const v2 = parseFixture("user-message.json");
    if (v2.payload.type !== "user_message") {
      throw new Error("user-message fixture decoded to an unexpected payload");
    }
    const legacyEnvelope: Envelope = {
      thread_id: v2.thread_id,
      seq: v2.seq,
      client_message_id: v2.client_message_id,
      payload: {
        type: "user_message",
        data: {
          text: v2.payload.data.text,
          files: v2.payload.data.files,
        },
      },
    };

    const shadow = projectWithMetrics([legacyEnvelope]);
    expect(shadow.metrics.outOfOrder).toBe(1);
    expect(shadow.view.threads[0]?.user).toBeNull();
  });
});
