import { describe, expect, it, vi } from "vitest";
import {
  attachRouter,
  handleApprovalRequested,
} from "./ui-protocol-event-router";
import type {
  ApprovalRequestedEvent,
  UiProtocolBridge,
} from "./ui-protocol-bridge";

function bridgeProbe(): {
  bridge: UiProtocolBridge;
  subscriptions: Map<string, unknown>;
} {
  const subscriptions = new Map<string, unknown>();
  const bridge = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string") return undefined;
        if (property.startsWith("on")) {
          return (handler: unknown) => {
            subscriptions.set(property, handler);
            return () => subscriptions.delete(property);
          };
        }
        return vi.fn();
      },
    },
  ) as UiProtocolBridge;
  return { bridge, subscriptions };
}

describe("ui-protocol event router", () => {
  it("subscribes to retained streams without a message/persisted listener", () => {
    const { bridge, subscriptions } = bridgeProbe();
    const attachment = attachRouter(bridge, { sessionId: "session-router" });

    expect(subscriptions.has("onMessageDelta")).toBe(true);
    expect(subscriptions.has("onSpawnComplete")).toBe(true);
    expect(subscriptions.has("onTaskUpdated")).toBe(true);
    expect(subscriptions.has("onMessagePersisted")).toBe(false);

    attachment.detach();
    expect(subscriptions.size).toBe(0);
  });

  it("keeps approval events on the retained control-plane path", () => {
    const events: Event[] = [];
    const event: ApprovalRequestedEvent = {
      session_id: "session-router",
      approval_id: "approval-1",
      turn_id: "turn-1",
      tool_name: "shell",
      title: "Run command?",
      body: "pwd",
      approval_kind: "shell.exec",
      approval_scope: "request",
      risk: "low",
    };

    handleApprovalRequested(
      { sessionId: "session-router", dispatchEvent: (entry) => events.push(entry) },
      event,
    );

    expect(events).toHaveLength(1);
    expect((events[0] as CustomEvent).detail).toEqual(event);
  });
});
