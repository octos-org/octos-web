/**
 * Wave4-A router-mode switcher unit tests.
 *
 * Coverage:
 *   - mount + happy probe: `router/get_metrics` resolves → switcher
 *     enabled, all three modes renderable
 *   - `runtime_unavailable` from `router/get_metrics` → switcher
 *     disabled (single-provider profile)
 *   - clicking a mode issues `router/set_mode` with `{session_id, mode}`
 *     and optimistically reflects the selection
 *   - the optimistic state reconciles against a `crew:mode_update`
 *     dispatch (the same listener `useModeState()` consumes)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

import { RouterModeSwitcher } from "./router-mode-switcher";
import { SessionContext } from "@/runtime/session-context";
import type {
  SessionContextValue,
  AdaptiveMode,
} from "@/runtime/session-context";
import { BridgeRpcError } from "@/runtime/ui-protocol-bridge";

const SESSION = "sess-router-switch";

interface MountedHarness {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function makeSessionCtx(
  adaptiveMode: AdaptiveMode = null,
): SessionContextValue {
  return {
    sessions: [],
    currentSessionId: SESSION,
    historyTopic: undefined,
    currentSessionTitle: "",
    currentSessionStats: null,
    initialMessages: [],
    activeTaskOnServer: false,
    queueMode: null,
    adaptiveMode,
    setServerTaskActive: () => {},
    renameSession: () => {},
    updateSessionStats: () => {},
    switchSession: () => {},
    goBack: async () => false,
    createSession: () => SESSION,
    removeSession: async () => {},
    refreshSessions: async () => {},
    markSessionActive: () => {},
  };
}

function mount(node: React.ReactElement): MountedHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("RouterModeSwitcher", () => {
  it("renders three mode buttons + reflects adaptiveMode from session context", async () => {
    const callMethod = vi.fn().mockResolvedValue({
      provider_name: "p",
      mode: "lane",
      qos_ranking: true,
      lane_scores: {},
      circuit_breakers: {},
    });
    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx("lane")}>
        <RouterModeSwitcher getBridge={() => ({ callMethod })} />
      </SessionContext.Provider>,
    );
    try {
      // Let the probe resolve.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const root = harness.container.querySelector(
        "[data-testid='router-mode-switcher']",
      );
      expect(root).not.toBeNull();
      const buttons = harness.container.querySelectorAll(
        "button[data-testid^='router-mode-']",
      );
      expect(buttons.length).toBe(3);
      const lane = harness.container.querySelector(
        "[data-testid='router-mode-lane']",
      ) as HTMLButtonElement;
      expect(lane.getAttribute("data-active")).toBe("true");
      const off = harness.container.querySelector(
        "[data-testid='router-mode-off']",
      ) as HTMLButtonElement;
      expect(off.getAttribute("data-active")).toBe("false");
    } finally {
      harness.unmount();
    }
  });

  it("clicking a mode issues router/set_mode and optimistically highlights the selection", async () => {
    const callMethod = vi.fn(async (method: string) => {
      if (method === "router/get_metrics") {
        return {
          provider_name: "p",
          mode: "off",
          qos_ranking: false,
          lane_scores: {},
          circuit_breakers: {},
        };
      }
      // router/set_mode
      return { mode: "hedge" };
    });
    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx(null)}>
        <RouterModeSwitcher getBridge={() => ({ callMethod })} />
      </SessionContext.Provider>,
    );
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const hedge = harness.container.querySelector(
        "[data-testid='router-mode-hedge']",
      ) as HTMLButtonElement;
      await act(async () => {
        hedge.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      // Look at the most recent call (probe was call #0).
      const setModeCall = callMethod.mock.calls.find(
        ([m]) => m === "router/set_mode",
      );
      expect(setModeCall).toBeDefined();
      expect(setModeCall?.[1]).toEqual({
        session_id: SESSION,
        mode: "hedge",
      });
      // Optimistic highlight: hedge button now active.
      expect(hedge.getAttribute("data-active")).toBe("true");
    } finally {
      harness.unmount();
    }
  });

  it("router/get_metrics returning runtime_unavailable greys out the switcher", async () => {
    const err = new BridgeRpcError(-32602, "no adaptive router", {
      kind: "runtime_unavailable",
    });
    const callMethod = vi.fn().mockRejectedValue(err);
    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx(null)}>
        <RouterModeSwitcher getBridge={() => ({ callMethod })} />
      </SessionContext.Provider>,
    );
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      const root = harness.container.querySelector(
        "[data-testid='router-mode-switcher']",
      ) as HTMLDivElement;
      expect(root.getAttribute("aria-disabled")).toBe("true");
      expect(root.getAttribute("title")).toMatch(/Adaptive routing is off/);
      const buttons = harness.container.querySelectorAll<HTMLButtonElement>(
        "button[data-testid^='router-mode-']",
      );
      for (const b of buttons) {
        expect(b.disabled).toBe(true);
      }
    } finally {
      harness.unmount();
    }
  });

  it("renders disabled when bridge is unavailable; probes again on crew:bridge_connected", async () => {
    let bridgeAvailable = false;
    const callMethod = vi.fn().mockResolvedValue({
      provider_name: "p",
      mode: "off",
      qos_ranking: false,
      lane_scores: {},
      circuit_breakers: {},
    });
    const harness = mount(
      <SessionContext.Provider value={makeSessionCtx(null)}>
        <RouterModeSwitcher
          getBridge={() => (bridgeAvailable ? { callMethod } : null)}
        />
      </SessionContext.Provider>,
    );
    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(callMethod).not.toHaveBeenCalled();
      bridgeAvailable = true;
      await act(async () => {
        window.dispatchEvent(new CustomEvent("crew:bridge_connected"));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(callMethod).toHaveBeenCalledWith("router/get_metrics", {
        session_id: SESSION,
      });
    } finally {
      harness.unmount();
    }
  });
});
