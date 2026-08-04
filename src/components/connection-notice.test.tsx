import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConnectionState } from "@/runtime/ui-protocol-types";
import { ConnectionNotice } from "./connection-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const runtimeMocks = vi.hoisted(() => ({
  listener: null as ((state: ConnectionState | null) => void) | null,
}));

vi.mock("@/runtime/ui-protocol-runtime", () => ({
  onActiveConnectionStateChange: (
    listener: (state: ConnectionState | null) => void,
  ) => {
    runtimeMocks.listener = listener;
    return () => {
      runtimeMocks.listener = null;
    };
  },
}));

function emit(state: ConnectionState | null) {
  act(() => {
    runtimeMocks.listener?.(state);
  });
}

function mount(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(<ConnectionNotice />));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function notice(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="connection-notice"]');
}

describe("ConnectionNotice", () => {
  beforeEach(() => {
    runtimeMocks.listener = null;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays silent with no bridge and during the initial handshake", () => {
    const harness = mount();
    emit(null);
    expect(notice(harness.container)).toBeNull();
    emit("connecting");
    expect(notice(harness.container)).toBeNull();
    harness.unmount();
  });

  it("stays silent while connected", () => {
    const harness = mount();
    emit("connected");
    expect(notice(harness.container)).toBeNull();
    harness.unmount();
  });

  it("warns on a post-connect drop and clears when the bridge recovers", () => {
    const harness = mount();
    emit("connected");
    emit("reconnecting");
    const el = notice(harness.container);
    expect(el?.getAttribute("data-connection-notice")).toBe("reconnecting");
    expect(el?.textContent).toContain("reconnecting");
    expect(el?.textContent).toContain("will send when it's back");

    emit("connected");
    expect(notice(harness.container)).toBeNull();
    harness.unmount();
  });

  it("offers a reload once the reconnect budget is spent", () => {
    const harness = mount();
    emit("connected");
    emit("reconnecting");
    emit("closed");
    const el = notice(harness.container);
    expect(el?.getAttribute("data-connection-notice")).toBe("lost");
    expect(el?.textContent).toContain("couldn't be restored");
    expect(
      el?.querySelector('[data-testid="connection-notice-reload"]'),
    ).not.toBeNull();
    harness.unmount();
  });

  it("ignores a terminal state that never saw a successful connect", () => {
    const harness = mount();
    // Backend down on arrival: the bridge never connects. The login/empty
    // surfaces own that story — no mid-page banner flicker.
    emit("connecting");
    emit("closed");
    expect(notice(harness.container)).toBeNull();
    harness.unmount();
  });

  it("keeps the notice through transient recovery states instead of flickering", () => {
    const harness = mount();
    emit("connected");
    emit("reconnecting");
    emit("connecting");
    expect(notice(harness.container)?.getAttribute("data-connection-notice")).toBe(
      "reconnecting",
    );
    harness.unmount();
  });

  it("signals a local network drop instantly instead of waiting for the keepalive", () => {
    const harness = mount();
    emit("connected");
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    const el = notice(harness.container);
    expect(el?.getAttribute("data-connection-notice")).toBe("offline");
    expect(el?.textContent).toContain("You're offline");

    // Network back, bridge state hasn't moved yet — the banner clears.
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(notice(harness.container)).toBeNull();

    // If the socket DID die while offline, the bridge's own state takes over.
    emit("reconnecting");
    expect(
      notice(harness.container)?.getAttribute("data-connection-notice"),
    ).toBe("reconnecting");
    harness.unmount();
  });

  it("stays silent about an offline event that precedes any connection", () => {
    const harness = mount();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(notice(harness.container)).toBeNull();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    harness.unmount();
  });
});
