/**
 * Wave4-A adaptive router mode switcher.
 *
 * Renders three buttons (Off / Lane / Hedge) in the chat header next to
 * the cost-bar. The active mode is highlighted; clicking another mode
 * issues `router/set_mode` over the live UI Protocol v1 bridge and
 * optimistically reflects the new mode locally — the next
 * `router/status` notification reconciles the optimistic state.
 *
 * Discovery: on mount, the component issues `router/get_metrics` to
 * detect whether an adaptive router is attached. The server returns an
 * RPC `invalid_params` error with `data.kind === "runtime_unavailable"`
 * when the session has only a single provider (no adaptive routing
 * possible), in which case the switcher renders disabled with a
 * tooltip explanation.
 *
 * Sourcing notes:
 *   - `useSession()` provides `currentSessionId` + `historyTopic` so we
 *     pull the bridge for the active scope.
 *   - `getActiveBridge` is the runtime registry; null while the bridge
 *     is mid-handshake, in which case we render disabled until the
 *     `crew:bridge_connected` event fires.
 *   - The `crew:mode_update` listener in `useModeState()` already
 *     receives the server-side reconciliation push; we read that mode
 *     value to render the active highlight.
 */

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/runtime/session-context";
import type { AdaptiveMode } from "@/runtime/session-context";
import { getActiveBridge } from "@/runtime/ui-protocol-runtime";
import { METHODS, BridgeRpcError } from "@/runtime/ui-protocol-bridge";
import type {
  RouterGetMetricsResult,
  RouterSetModeResult,
} from "@/runtime/ui-protocol-types";

type SwitcherMode = "off" | "lane" | "hedge";
const MODE_LABELS: Record<SwitcherMode, string> = {
  off: "Off",
  lane: "Lane",
  hedge: "Hedge",
};
const MODES: SwitcherMode[] = ["off", "lane", "hedge"];

/** Treat any RPC error whose `data.kind` equals `runtime_unavailable`
 *  as the "no adaptive router attached" signal — the server returns it
 *  from both `handle_router_set_mode` and `handle_router_get_metrics`
 *  when the session's provider chain isn't wrapped in `AdaptiveRouter`. */
function isRuntimeUnavailable(err: unknown): boolean {
  if (!(err instanceof BridgeRpcError)) return false;
  const data = err.data;
  if (data && typeof data === "object" && "kind" in data) {
    const kind = (data as { kind?: unknown }).kind;
    return kind === "runtime_unavailable";
  }
  return false;
}

export interface RouterModeSwitcherProps {
  /** Test-injection: bypass the live bridge resolver. */
  getBridge?: () => {
    callMethod: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  } | null;
  /** Test-injection: bypass `useSession()` for component-level tests. */
  sessionId?: string;
}

export function RouterModeSwitcher({
  getBridge,
  sessionId,
}: RouterModeSwitcherProps = {}) {
  const session = useSession();
  const activeSessionId = sessionId ?? session.currentSessionId;
  const adaptiveMode = session.adaptiveMode;

  // Local optimistic mode — set on click, cleared when the next
  // `router/status` notification (via session-context's `adaptiveMode`)
  // matches it. Renders as the active highlight even before the server
  // reconciliation arrives.
  const [optimisticMode, setOptimisticMode] = useState<SwitcherMode | null>(
    null,
  );
  // `null` = not yet probed; `true` = adaptive router available;
  // `false` = `runtime_unavailable` (single-provider profile). The
  // switcher renders disabled when `false`.
  const [available, setAvailable] = useState<boolean | null>(null);
  // True while a `router/set_mode` RPC is in flight; locks every button.
  const [busy, setBusy] = useState(false);

  const resolveBridge = useCallback(() => {
    if (getBridge) return getBridge();
    return getActiveBridge(activeSessionId, session.historyTopic);
  }, [getBridge, activeSessionId, session.historyTopic]);

  // Probe once on mount / sessionId change. The probe is best-effort —
  // if the bridge is not yet connected, leave `available = null` and
  // re-try on the next `crew:bridge_connected` window event.
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      const bridge = resolveBridge();
      if (!bridge) return;
      try {
        await bridge.callMethod<RouterGetMetricsResult>(
          METHODS.ROUTER_GET_METRICS,
          { session_id: activeSessionId },
        );
        if (!cancelled) setAvailable(true);
      } catch (err) {
        if (cancelled) return;
        if (isRuntimeUnavailable(err)) {
          setAvailable(false);
        }
        // Other errors (transient): leave `available = null` so a later
        // probe (next session switch / bridge reconnect) gets a fresh
        // chance.
      }
    }
    void probe();
    function onBridgeConnected() {
      if (!cancelled) void probe();
    }
    if (typeof window !== "undefined") {
      window.addEventListener("crew:bridge_connected", onBridgeConnected);
    }
    return () => {
      cancelled = true;
      if (typeof window !== "undefined") {
        window.removeEventListener(
          "crew:bridge_connected",
          onBridgeConnected,
        );
      }
    };
  }, [activeSessionId, resolveBridge]);

  // Reconcile the optimistic state once the server-side mode arrives via
  // `router/status` (fed through `useModeState()` → `adaptiveMode`).
  useEffect(() => {
    if (optimisticMode && adaptiveMode === optimisticMode) {
      setOptimisticMode(null);
    }
  }, [adaptiveMode, optimisticMode]);

  const handleClick = useCallback(
    async (mode: SwitcherMode) => {
      if (busy) return;
      const bridge = resolveBridge();
      if (!bridge) return;
      setOptimisticMode(mode);
      setBusy(true);
      try {
        await bridge.callMethod<RouterSetModeResult>(
          METHODS.ROUTER_SET_MODE,
          { session_id: activeSessionId, mode },
        );
        // Success: hold the optimistic mode until `router/status`
        // confirms. The reconcile effect above clears it then.
      } catch (err) {
        // Roll the optimistic state back. If the failure is
        // `runtime_unavailable`, flip the disabled flag so the user
        // doesn't keep retrying.
        setOptimisticMode(null);
        if (isRuntimeUnavailable(err)) {
          setAvailable(false);
        }
      } finally {
        setBusy(false);
      }
    },
    [activeSessionId, busy, resolveBridge],
  );

  // Effective rendered mode: optimistic wins (so click → instant feedback);
  // otherwise read the reconciled `adaptiveMode` from session context.
  const renderedMode: AdaptiveMode =
    optimisticMode ??
    (adaptiveMode === "off" || adaptiveMode === "lane" || adaptiveMode === "hedge"
      ? adaptiveMode
      : null);
  const disabled = available === false || busy;
  const disabledTooltip =
    available === false
      ? "Adaptive routing is off for this profile."
      : undefined;

  return (
    <div
      data-testid="router-mode-switcher"
      role="radiogroup"
      aria-label="Adaptive router mode"
      aria-disabled={disabled ? "true" : "false"}
      className={`flex items-center gap-1 ${
        disabled ? "opacity-50 pointer-events-none" : ""
      }`}
      title={disabledTooltip}
    >
      {MODES.map((mode) => {
        const active = renderedMode === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`router-mode-${mode}`}
            data-mode={mode}
            data-active={active ? "true" : "false"}
            disabled={disabled}
            onClick={() => {
              void handleClick(mode);
            }}
            className={`glass-pill rounded-[10px] px-2 py-1 text-[10px] font-medium ${
              active ? "is-active" : ""
            }`}
          >
            {MODE_LABELS[mode]}
          </button>
        );
      })}
    </div>
  );
}
