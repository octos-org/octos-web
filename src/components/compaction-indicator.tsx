import { useEffect, useRef, useState } from "react";
import { useSession } from "@/runtime/session-context";
import { eventMatchesScope } from "@/runtime/event-scope";
import { progressBar } from "@/lib/progress-bar";

/**
 * Context-compaction indicator (UPCR-2026-026), the SPA sibling of
 * octos-tui#253's block:
 *
 * ```text
 * ✶ Compacting conversation… (12s · 87.4k tokens)
 *   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 91%
 * ```
 *
 * Consumes the scoped `crew:compaction` DOM event fanned out by the
 * ui-protocol event router. `phase: "started"` arms the in-progress
 * block; `phase: "completed"` swaps it for a transient success notice
 * (`✓ context compacted 87.4k → 31.2k tokens`) that auto-clears. The
 * serve pass is synchronous today, so started/completed usually arrive
 * in one batch — the in-progress state may only flash; the notice is
 * the durable part of the UX.
 *
 * The percentage is HONEST: pre-compaction tokens over the threshold
 * that tripped the pass (the started event carries it). We deliberately
 * do not invent a percentage on completed-only flows.
 */

const BAR_WIDTH = 40;
const NOTICE_AUTO_CLEAR_MS = 8000;

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

type CompactionState =
  | {
      phase: "started";
      tokenEstimate: number;
      thresholdTokens: number;
      startedAt: number;
    }
  | {
      phase: "completed";
      before: number;
      after: number | null;
      error: string | null;
    };

export function CompactionIndicator() {
  const { currentSessionId, historyTopic } = useSession();
  const [state, setState] = useState<CompactionState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const clearTimer = useRef<number | null>(null);

  useEffect(() => {
    // Scope change (session/topic switch): the previous conversation's
    // block must not bleed into the new one — reset local state whenever
    // the effect re-binds (codex R4).
    setState(null);
    setElapsed(0);
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      if (clearTimer.current != null) {
        window.clearTimeout(clearTimer.current);
        clearTimer.current = null;
      }
      if (detail.phase === "started") {
        setState({
          phase: "started",
          tokenEstimate: detail.token_estimate ?? 0,
          thresholdTokens: detail.threshold_tokens ?? 0,
          startedAt: Date.now(),
        });
        setElapsed(0);
        return;
      }
      if (detail.phase === "completed") {
        setState({
          phase: "completed",
          before: detail.token_estimate_before ?? 0,
          after:
            typeof detail.token_estimate_after === "number"
              ? detail.token_estimate_after
              : null,
          error: detail.error ?? null,
        });
        clearTimer.current = window.setTimeout(() => {
          setState(null);
          clearTimer.current = null;
        }, NOTICE_AUTO_CLEAR_MS);
      }
    }
    // Hang safety (the octos-tui#253 lesson): a compaction block must
    // never outlive its turn. `crew:thinking` falls at every turn
    // terminal, so a started-block whose completed event was lost is
    // cleared there; a completed notice keeps its own auto-clear timer.
    function thinkingHandler(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!eventMatchesScope(detail, currentSessionId, historyTopic)) return;
      if (!detail.thinking) {
        setState((prev) => (prev?.phase === "started" ? null : prev));
      }
    }
    window.addEventListener("crew:compaction", handler);
    window.addEventListener("crew:thinking", thinkingHandler);
    return () => {
      window.removeEventListener("crew:compaction", handler);
      window.removeEventListener("crew:thinking", thinkingHandler);
      if (clearTimer.current != null) {
        window.clearTimeout(clearTimer.current);
        clearTimer.current = null;
      }
    };
  }, [currentSessionId, historyTopic]);

  useEffect(() => {
    if (state?.phase !== "started") return;
    const startedAt = state.startedAt;
    const tick = () =>
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [state]);

  if (!state) return null;

  if (state.phase === "started") {
    const frac =
      state.thresholdTokens > 0 ? state.tokenEstimate / state.thresholdTokens : 0;
    const pct = Math.round(Math.min(1, Math.max(0, frac)) * 100);
    return (
      <div
        data-testid="compaction-indicator"
        className="mx-4 my-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted"
      >
        <div>
          ✶ Compacting conversation…
          {elapsed >= 1 ? ` (${elapsed}s · ${formatTokens(state.tokenEstimate)} tokens)` : ` (${formatTokens(state.tokenEstimate)} tokens)`}
        </div>
        <div className="font-mono text-xs" data-testid="compaction-bar">
          {progressBar(frac, BAR_WIDTH)} {pct}% of compact threshold
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div
        data-testid="compaction-indicator"
        className="mx-4 my-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted"
      >
        ✗ context compaction failed: {state.error}
      </div>
    );
  }

  const after = state.after ?? state.before;
  return (
    <div
      data-testid="compaction-indicator"
      className="mx-4 my-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted"
    >
      ✓ context compacted {formatTokens(state.before)} → {formatTokens(after)} tokens
    </div>
  );
}
