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

import { useCallback, useEffect, useRef, useState } from "react";
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
  const activeTopic = session.historyTopic;
  const adaptiveMode = session.adaptiveMode;

  // Local optimistic mode — set on click. Cleared when an
  // authoritative `adaptiveMode` value DIFFERENT FROM THE ONE AT
  // CLICK TIME arrives via `router/status` (the codex round 2 P2 fix:
  // the prior reconcile cleared on any `off|lane|hedge` push, which
  // for a session whose current mode is "off" caused the optimistic
  // click to "hedge" to flicker back to "off" before the server
  // reflected the new mode). `adaptiveModeAtClickRef` pins the
  // pre-click reference so we can detect "new mode observed".
  const [optimisticMode, setOptimisticMode] = useState<SwitcherMode | null>(
    null,
  );
  const adaptiveModeAtClickRef = useRef<AdaptiveMode>(null);
  // `null` = not yet probed; `true` = adaptive router available;
  // `false` = `runtime_unavailable` (single-provider profile). The
  // switcher renders disabled when `false`.
  const [available, setAvailable] = useState<boolean | null>(null);
  // True while a `router/set_mode` RPC is in flight; locks every button.
  const [busy, setBusy] = useState(false);

  // Codex Wave4-A P2 review fix: mirror the full SCOPE (session +
  // topic) into refs so async RPC callbacks can compare against the
  // LATEST value (not the closure snapshot from the render when the
  // RPC was issued). Without this, `issuedFor !== activeSessionId`
  // compared two captures from the same render and never detected a
  // mid-flight scope switch.
  const activeSessionIdRef = useRef(activeSessionId);
  const activeTopicRef = useRef(activeTopic);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    activeTopicRef.current = activeTopic;
  }, [activeSessionId, activeTopic]);

  // Codex Wave4-A P2 (rounds 2+3) review fix: reset local switcher
  // state on scope (session/topic) change so a previous scope's
  // `runtime_unavailable` flag, optimistic mode, or busy lock doesn't
  // carry over. The probe useEffect below re-runs (its dep array
  // includes `activeSessionId`) and re-probes the new scope.
  useEffect(() => {
    setOptimisticMode(null);
    adaptiveModeAtClickRef.current = null;
    setAvailable(null);
    setBusy(false);
  }, [activeSessionId, activeTopic]);

  // Reconcile the optimistic state ONLY when an authoritative
  // `adaptiveMode` value DIFFERENT from the one we observed at click
  // time arrives. This handles both branches:
  //   - server commits the user's optimistic click → adaptiveMode
  //     transitions to that value → reconcile fires → optimistic
  //     cleared (and `renderedMode` falls back to the freshly-pushed
  //     `adaptiveMode`, which equals the optimistic mode anyway).
  //   - server rejects / coerces → adaptiveMode transitions to a
  //     different value → reconcile fires → optimistic cleared and
  //     the rendered state reflects the server-committed mode.
  //
  // If `adaptiveMode` is still the pre-click value, we hold the
  // optimistic highlight (no flicker). When `adaptiveMode` was null
  // pre-click (fresh session, never reconciled), any subsequent
  // authoritative push clears the optimistic value.
  useEffect(() => {
    if (!optimisticMode) return;
    if (adaptiveMode === null) return;
    if (adaptiveMode === adaptiveModeAtClickRef.current) return;
    setOptimisticMode(null);
    adaptiveModeAtClickRef.current = null;
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
      // Pin the SCOPE this click is for via refs (codex Wave4-A P2
      // rounds 2-3): both session id AND topic must match at RPC
      // resolve time. Closure-captured comparisons against
      // `activeSessionId` / `activeTopic` are tautologies because they
      // come from the same render; refs carry the latest scope.
      const issuedForSession = activeSessionId;
      const issuedForTopic = activeTopic;
      const scopeStillCurrent = () =>
        issuedForSession === activeSessionIdRef.current &&
        issuedForTopic === activeTopicRef.current;
      adaptiveModeAtClickRef.current = adaptiveMode;
      setOptimisticMode(mode);
      setBusy(true);
      try {
        const result = await bridge.callMethod<RouterSetModeResult>(
          METHODS.ROUTER_SET_MODE,
          { session_id: issuedForSession, mode },
        );
        if (!scopeStillCurrent()) return;
        // Codex Wave4-A P1: trust the server's echo. If the server
        // committed a different mode (e.g. silently coerced an unknown
        // value back to `off`), reflect that. We hold the resolved
        // mode locally until `router/status` (via `adaptiveMode`)
        // catches up — the reconcile useEffect above clears it the
        // moment any DIFFERENT authoritative mode arrives, so we
        // never freeze on a stale optimistic value even when the
        // server reports a different mode than the user's click.
        const echoed = normalizeAdaptiveMode(result?.mode ?? "");
        if (echoed && echoed !== mode) {
          setOptimisticMode(echoed);
        }
        // If echoed === mode (typical happy path), leave the
        // optimistic value as-is — the next `router/status` push
        // clears it. If echoed is null (unparsed), also leave the
        // optimistic value visible so the click stays responsive;
        // the reconcile effect will replace it when adaptiveMode
        // transitions away from the pre-click value.
      } catch (err) {
        if (issuedFor !== activeSessionIdRef.current) return;
        // Roll the optimistic state back. If the failure is
        // `runtime_unavailable`, flip the disabled flag so the user
        // doesn't keep retrying.
        setOptimisticMode(null);
        adaptiveModeAtClickRef.current = null;
        if (isRuntimeUnavailable(err)) {
          setAvailable(false);
        }
      } finally {
        if (issuedFor === activeSessionIdRef.current) setBusy(false);
      }
    },
    [activeSessionId, adaptiveMode, busy, resolveBridge],
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
