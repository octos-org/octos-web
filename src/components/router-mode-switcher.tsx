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

/** Normalize a server-emitted mode string (`"off"` / `"hedge"` /
 *  `"lane"`) into the local `SwitcherMode` shape. Unknown values map
 *  back to `null` so we never highlight a button that doesn't exist. */
function normalizeAdaptiveMode(mode: string): SwitcherMode | null {
  if (mode === "off" || mode === "hedge" || mode === "lane") return mode;
  return null;
}

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

  // Local optimistic mode — set on click, cleared the moment EITHER
  // the `router/set_mode` RPC echoes a mode back OR the next
  // `router/status` notification arrives (codex Wave4-A P1 review fix:
  // the old "wait for `adaptiveMode === optimisticMode`" gate could
  // never clear when the server reports a different mode than the
  // user's optimistic click).
  const [optimisticMode, setOptimisticMode] = useState<SwitcherMode | null>(
    null,
  );
  // `null` = not yet probed; `true` = adaptive router available;
  // `false` = `runtime_unavailable` (single-provider profile). The
  // switcher renders disabled when `false`.
  const [available, setAvailable] = useState<boolean | null>(null);
  // True while a `router/set_mode` RPC is in flight; locks every button.
  const [busy, setBusy] = useState(false);

  // Codex Wave4-A P2 review fix: reset local switcher state on session
  // change so a previous session's `runtime_unavailable` flag,
  // optimistic mode, or busy lock doesn't carry over to a freshly
  // switched session. The probe useEffect below re-runs (its dep
  // array includes `activeSessionId`) and re-probes the new scope.
  useEffect(() => {
    setOptimisticMode(null);
    setAvailable(null);
    setBusy(false);
  }, [activeSessionId]);

  // Reconcile the optimistic state against the live `adaptiveMode` from
  // session context (fed by `crew:mode_update` → `useModeState()`).
  // Any authoritative same-session status drop clears the optimistic
  // highlight — even when the reported mode disagrees with the
  // optimistic value (e.g. server rejected the mode silently). This
  // also runs when the optimistic mode is cleared by the RPC echo
  // path, in which case it's a cheap no-op.
  useEffect(() => {
    if (
      optimisticMode &&
      (adaptiveMode === "off" ||
        adaptiveMode === "lane" ||
        adaptiveMode === "hedge")
    ) {
      setOptimisticMode(null);
    }
  }, [adaptiveMode, optimisticMode]);

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

  const handleClick = useCallback(
    async (mode: SwitcherMode) => {
      if (busy) return;
      const bridge = resolveBridge();
      if (!bridge) return;
      // Pin the session this click is for. Codex Wave4-A P2: if the
      // user switches sessions while `router/set_mode` is in flight,
      // we drop the result instead of letting it leak into the new
      // session's local state.
      const issuedFor = activeSessionId;
      setOptimisticMode(mode);
      setBusy(true);
      try {
        const result = await bridge.callMethod<RouterSetModeResult>(
          METHODS.ROUTER_SET_MODE,
          { session_id: issuedFor, mode },
        );
        if (issuedFor !== activeSessionId) return;
        // Codex Wave4-A P1: trust the server's echo. If the server
        // committed a different mode (e.g. silently coerced an unknown
        // value back to `off`), reflect that. We hold the resolved
        // mode locally until `router/status` (via `adaptiveMode`)
        // catches up — the reconcile useEffect above clears it the
        // moment ANY authoritative mode arrives, so we never freeze
        // on a stale optimistic value even when the server reports a
        // different mode than the user's click.
        const echoed = normalizeAdaptiveMode(result?.mode ?? "");
        if (echoed && echoed !== mode) {
          setOptimisticMode(echoed);
        }
        // If echoed === mode (typical happy path), leave the
        // optimistic value as-is — the next `router/status` push
        // clears it. If echoed is null (unparsed), also leave the
        // optimistic value visible so the click stays responsive;
        // the reconcile effect will replace it when adaptiveMode
        // catches up.
      } catch (err) {
        if (issuedFor !== activeSessionId) return;
        // Roll the optimistic state back. If the failure is
        // `runtime_unavailable`, flip the disabled flag so the user
        // doesn't keep retrying.
        setOptimisticMode(null);
        if (isRuntimeUnavailable(err)) {
          setAvailable(false);
        }
      } finally {
        if (issuedFor === activeSessionId) setBusy(false);
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
