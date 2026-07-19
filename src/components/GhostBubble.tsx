/**
 * M9-γ-4: `<GhostBubble>` overlay — purely visual optimistic UI.
 *
 * Spec:  `api/OCTOS_UI_PROTOCOL_V1_SPEC_2026-04-24.md` § 14 (M9-γ Envelope).
 * ADR:   `docs/M9-GAMMA-SERVER-PROJECTION-ADR.md` (PR #830).
 * Issue: octos-org/octos#841.
 * Canonical state: `src/store/projection-store.ts`.
 *
 * When the server negotiates canonical projection v2, clicking Send no longer
 * mutates `ThreadStore` synchronously. The Composer instead mounts one
 * of these `<GhostBubble>` rows in its own React tree — visually
 * identical to a real user bubble — and marks it settled once the projection
 * sees a `UserView` with a matching `client_message_id`. The parent removes a
 * successful settled overlay after terminal completion, but keeps a compact
 * retry/error state if that terminal fails.
 *
 * The ghost is OUTSIDE `ThreadStore`. This component owns its own
 * presentation state (text, files, attached_at). On every projection
 * `ingest()` (the only authoritative event that adds an envelope to
 * the log) we ask the projection-store via the O(1) `hasCmid` index
 * whether our cmid has landed; when it has, the ghost calls `onSettle` and
 * the parent records canonical settlement.
 *
 * Subscription model: we subscribe to `ProjectionStore.subscribe`, not
 * `ThreadStore.subscribe`. A v2 envelope becomes visible only after the
 * canonical store admits it, so this subscription closes the optimistic
 * overlay against the same source the renderer reads.
 *
 * Failure mode: if 30 seconds pass without settling, render an inline
 * error + retry button. The 30s timer is local to the component (no
 * global state). Retry calls a parent-supplied callback; failure does
 * NOT pollute ThreadStore.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import * as ProjectionStore from "@/store/projection-store";
import { projectionStoreKey } from "@/store/projection-store";
import { UserBubbleShell } from "./user-bubble-shell";

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
   *  === clientMessageId`. The parent owns final terminal lifecycle. */
  onSettle: () => void;
  /** Immediate transport/RPC failure supplied by the send path. Unlike the
   * timeout this is authoritative and must remain visible for retry. */
  failure?: string;
  /** The canonical user row has landed. A later terminal failure renders a
   * compact retry affordance instead of duplicating that user bubble. */
  settled?: boolean;
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Visual-only optimistic user bubble. Mounted by the Composer on Send
 * for a negotiated projection-v2 session; hidden after a successful terminal
 * and retained as an explicit retry state when failure occurs.
 */
export function GhostBubble({
  clientMessageId,
  text,
  files,
  sessionId,
  topic,
  onSettle,
  failure,
  settled = false,
  onRetry,
}: GhostBubbleProps): React.ReactElement {
  // attached_at is captured ONCE at mount so re-renders (e.g. from a
  // projection-store notify) don't bump the displayed timestamp. We
  // use the lazy-init form of `useState` so `Date.now()` is invoked
  // exactly once (the initializer fn runs only on first render — no
  // impure call during subsequent renders, and ESLint's "impure
  // function in render" rule passes).
  const [attachedAt, setAttachedAt] = useState<number>(() => Date.now());
  const [timedOut, setTimedOut] = useState<boolean>(false);
  const settledRef = useRef<boolean>(false);

  const storeKey = useMemo(
    () => projectionStoreKey(sessionId, topic),
    [sessionId, topic],
  );

  // Subscribe to projection-store ingests. The projection-store fires
  // its listeners AFTER each `ingest()` commits — so our `hasCmid`
  // check is guaranteed to see the new envelope. (Subscribing to
  // ThreadStore is intentionally not involved: v2 never dual-writes through
  // the legacy reducer.)
  //
  // Cmid lookup is O(1) — backed by `projection-store`'s
  // `cmidToThread` index, populated as a side effect of `ingest()`.
  useEffect(() => {
    if (settled || settledRef.current) return;

    // Fast-path: the projection might already carry our cmid by the
    // time this effect runs (for example, server reflection landed inside
    // the same microtask as the send dispatch). Settling synchronously here
    // is safe — the parent records the settled state and removes it after a
    // successful terminal.
    if (ProjectionStore.hasCmid(storeKey, clientMessageId)) {
      settledRef.current = true;
      onSettle();
      return;
    }

    const unsubscribe = ProjectionStore.subscribe(() => {
      if (settledRef.current) return;
      if (ProjectionStore.hasCmid(storeKey, clientMessageId)) {
        settledRef.current = true;
        unsubscribe();
        onSettle();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [settled, storeKey, clientMessageId, onSettle]);

  // Local 30s timeout — purely component-scoped, no global state.
  useEffect(() => {
    if (settled || timedOut || failure) return;
    const id = window.setTimeout(() => {
      if (settledRef.current) return;
      setTimedOut(true);
    }, GHOST_SETTLE_TIMEOUT_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [failure, settled, timedOut]);

  const handleRetry = useCallback(() => {
    if (!onRetry) return;
    // Reset timeout so the retry gets a fresh 30s budget. Settling is
    // still gated on the projection capturing our cmid.
    setTimedOut(false);
    setAttachedAt(Date.now());
    onRetry();
  }, [onRetry]);

  const showFiles = files.length > 0;

  // Visual structure delegates to `<UserBubbleShell>` so the ghost and
  // the canonical `<ThreadUserBubble>` share one source of truth for
  // markup + classes. The only ghost-specific deviations are:
  //   - the outer `data-testid="ghost-bubble"` so harness specs can
  //     target the optimistic overlay specifically;
  //   - file rendering: ghosts carry raw `File` objects (not yet
  //     uploaded), so we render them as pending "Sending…" pills
  //     rather than `<FileAttachment>` rows;
  //   - the optional inline error + Retry button when the 30s timer
  //     fires (passed via the shell's `trailing` slot).
  const fileRows = showFiles ? (
    <>
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
    </>
  ) : null;

  const failureMessage = failure ?? (timedOut ? "Send not confirmed within 30s." : null);
  const trailing = failureMessage ? (
    <div
      data-testid="ghost-bubble-error"
      role="alert"
      className="mt-1.5 flex items-center gap-2 rounded-[10px] border border-red-500/20 bg-red-500/12 px-3 py-1.5 text-[11px] text-red-400"
    >
      <span>{failureMessage}</span>
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
  ) : null;

  // The canonical user bubble is already rendered by the projection. If its
  // terminal arrives later with an error, preserve a retry/error state but do
  // not render a second copy of the user's text.
  if (settled && failureMessage) {
    return (
      <div
        data-testid="ghost-bubble-terminal-error"
        role="alert"
        className="mx-4 mt-2 flex items-center gap-2 rounded-[10px] border border-red-500/20 bg-red-500/12 px-3 py-1.5 text-[11px] text-red-400"
      >
        <span>{failureMessage}</span>
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
    );
  }

  return (
    <UserBubbleShell
      text={text || null}
      files={fileRows}
      footer={formatGhostTimestamp(attachedAt)}
      trailing={trailing}
      outerTestId="ghost-bubble"
      textTestId="ghost-bubble-text"
      outerDataAttributes={{
        "data-client-message-id": clientMessageId,
        "data-ghost-state": failure ? "failed" : timedOut ? "timed-out" : "pending",
      }}
    />
  );
}
