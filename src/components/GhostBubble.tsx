/**
 * M9-γ-4: `<GhostBubble>` overlay — purely visual optimistic UI.
 *
 * Spec:  `api/OCTOS_UI_PROTOCOL_V1_SPEC_2026-04-24.md` § 14 (M9-γ Envelope).
 * ADR:   `docs/M9-GAMMA-SERVER-PROJECTION-ADR.md` (PR #830).
 * Issue: octos-org/octos#841.
 * γ-3:   `src/store/projection-store.ts` (the projection log + flag).
 *
 * Under the `projection_v1` feature flag, clicking Send NO LONGER
 * mutates `ThreadStore` synchronously. The Composer instead mounts one
 * of these `<GhostBubble>` rows in its own React tree — visually
 * identical to a real user bubble — and unmounts it once the projection
 * sees a `UserView` with a matching `client_message_id`.
 *
 * The ghost is OUTSIDE `ThreadStore`. This component owns its own
 * presentation state (text, files, attached_at). On every
 * `ThreadStore.subscribe` notify (which the dual-write path triggers)
 * we inspect the projection-store's `UserView` for our cmid; when it
 * lands the ghost calls `onSettle` and the parent unmounts.
 *
 * Failure mode: if 30 seconds pass without settling, render an inline
 * error + retry button. The 30s timer is local to the component (no
 * global state). Retry calls a parent-supplied callback; failure does
 * NOT pollute ThreadStore.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import * as ThreadStore from "@/store/thread-store";
import {
  getProjection,
  projectionStoreKey,
} from "@/store/projection-store";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard ceiling on the optimistic settle wait. Past this, the ghost
 *  surfaces a Retry affordance so the user is never stuck staring at a
 *  bubble that has already been silently lost (e.g. WS dropped, server
 *  rejected). 30s matches the M9-γ ADR's optimistic-overlay budget. */
export const GHOST_SETTLE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GhostBubbleProps {
  /** Pinned client_message_id; the projection's `UserView` must carry
   *  this exact value for the ghost to settle. */
  clientMessageId: string;
  /** Visible text — same content the user typed (rendered identically
   *  to a `ThreadUserBubble` so the optimistic UI is indistinguishable
   *  from a settled bubble). */
  text: string;
  /** Pending file attachments (raw `File` objects, not yet uploaded).
   *  We render their names + a generic "Sending…" affordance so the
   *  user sees what's about to land. */
  files: File[];
  /** Session id the send was issued in — used to address the projection
   *  store. Kept explicit (rather than read from `useSession`) so the
   *  component is decoupled from the runtime context and trivially
   *  testable. */
  sessionId: string;
  /** Optional topic scope (mirrors `historyTopic`). */
  topic?: string;
  /** Fired once the projection has captured `UserView.client_message_id
   *  === clientMessageId`. The parent owns lifecycle and unmounts. */
  onSettle: () => void;
  /** Called when the user clicks Retry from the timeout error state.
   *  Implementation re-issues the send via the Composer's normal
   *  channel; failure must NOT pollute ThreadStore. */
  onRetry?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatGhostTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** True iff the projection's view has a thread whose `user.client_message_id`
 *  matches the supplied cmid. Internal — kept as a named function (not
 *  inlined) so the predicate is a single, testable choke point if the
 *  match semantics ever need to widen. */
function projectionHasUserCmid(
  storeKey: string,
  clientMessageId: string,
): boolean {
  const view = getProjection(storeKey);
  for (const t of view.threads) {
    if (t.user?.client_message_id === clientMessageId) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Visual-only optimistic user bubble. Mounted by the Composer on Send
 * under `projection_v1`; unmounted by the parent when `onSettle` fires
 * (or kept around in error state for the user to retry).
 */
export function GhostBubble({
  clientMessageId,
  text,
  files,
  sessionId,
  topic,
  onSettle,
  onRetry,
}: GhostBubbleProps): React.ReactElement {
  // attached_at is captured ONCE at mount so re-renders (e.g. from a
  // ThreadStore notify) don't bump the displayed timestamp. We use the
  // lazy-init form of `useState` so `Date.now()` is invoked exactly
  // once (the initializer fn runs only on first render — no impure
  // call during subsequent renders, and ESLint's "impure function in
  // render" rule passes).
  const [attachedAt, setAttachedAt] = useState<number>(() => Date.now());
  const [timedOut, setTimedOut] = useState<boolean>(false);
  const settledRef = useRef<boolean>(false);

  const storeKey = useMemo(
    () => projectionStoreKey(sessionId, topic),
    [sessionId, topic],
  );

  // Subscribe to ThreadStore notifications. Each notify means an envelope
  // was just dual-written into the projection — re-check whether our cmid
  // has landed. We DON'T subscribe to a projection-store notify channel
  // (γ-3 doesn't expose one); the dual-write fires `notify()` on every
  // ingest, which is exactly what we need.
  useEffect(() => {
    if (settledRef.current) return;

    // Fast-path: the projection might already carry our cmid by the
    // time this effect runs (rare race: server reflection landed inside
    // the same microtask as the send dispatch). Settling synchronously
    // here is safe — the parent's unmount will tear down the timer below.
    if (projectionHasUserCmid(storeKey, clientMessageId)) {
      settledRef.current = true;
      onSettle();
      return;
    }

    const unsubscribe = ThreadStore.subscribe(() => {
      if (settledRef.current) return;
      if (projectionHasUserCmid(storeKey, clientMessageId)) {
        settledRef.current = true;
        unsubscribe();
        onSettle();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [storeKey, clientMessageId, onSettle]);

  // Local 30s timeout — purely component-scoped, no global state.
  useEffect(() => {
    if (timedOut) return;
    const id = window.setTimeout(() => {
      if (settledRef.current) return;
      setTimedOut(true);
    }, GHOST_SETTLE_TIMEOUT_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [timedOut]);

  const handleRetry = useCallback(() => {
    if (!onRetry) return;
    // Reset timeout so the retry gets a fresh 30s budget. Settling is
    // still gated on the projection capturing our cmid.
    setTimedOut(false);
    setAttachedAt(Date.now());
    onRetry();
  }, [onRetry]);

  const visibleText = text;
  const showFiles = files.length > 0;

  // Visual structure mirrors `ThreadUserBubble` in `chat-thread.tsx`
  // (right-aligned, same `message-card-user` glass classes, same
  // timestamp footer). The only deviations are:
  //   - the outer test id (`ghost-bubble`) so harness specs can target
  //     the optimistic overlay specifically;
  //   - the optional inline error + Retry button when the 30s timer
  //     fires.
  return (
    <div
      data-testid="ghost-bubble"
      data-client-message-id={clientMessageId}
      data-ghost-state={timedOut ? "timed-out" : "pending"}
      className="flex justify-end px-4 py-3"
    >
      <div className="flex max-w-[74%] flex-col items-end">
        {visibleText && (
          <div
            data-testid="ghost-bubble-text"
            className="message-card message-card-user rounded-[14px] rounded-br-[4px] px-4 py-2.5 text-sm leading-relaxed text-text"
          >
            {visibleText}
          </div>
        )}
        {showFiles && (
          <div className={`${visibleText ? "mt-2" : ""} flex flex-wrap gap-2`}>
            {files.map((f, idx) => (
              <div
                // `File` objects don't have a stable id; pair name + size
                // + index so duplicate filenames in the same send still
                // render distinct rows.
                key={`${f.name}-${f.size}-${idx}`}
                data-testid="ghost-bubble-file"
                className="glass-pill inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[10px] px-3 py-2 text-xs text-link"
              >
                <Download size={14} className="shrink-0" />
                <span className="truncate">{f.name}</span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-1.5 px-1 text-[10px] text-muted/50 select-none">
          {formatGhostTimestamp(attachedAt)}
        </div>
        {timedOut && (
          <div
            data-testid="ghost-bubble-error"
            role="alert"
            className="mt-1.5 flex items-center gap-2 rounded-[10px] border border-red-500/20 bg-red-500/12 px-3 py-1.5 text-[11px] text-red-400"
          >
            <span>Send not confirmed within 30s.</span>
            {onRetry && (
              <button
                data-testid="ghost-bubble-retry"
                type="button"
                onClick={handleRetry}
                className="rounded-md bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-700"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
