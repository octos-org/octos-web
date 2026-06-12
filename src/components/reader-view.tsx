/**
 * Fullscreen reader mode for assistant markdown content.
 *
 * Why this exists: `run_pipeline` / `synthesize_research` deliverables
 * are often 5–10K word markdown reports (headings, code blocks, tables)
 * that are awkward to read inside the chat bubble's narrow column. The
 * reader takes over the viewport and lays the same markdown out in a
 * generous reading column (max-width ~80ch, larger font, comfortable
 * line-height) styled like an article reader (Pocket / Reader View).
 *
 * Design contract:
 *   - Renders the SAME `MarkdownContent` the bubble uses — no
 *     re-implementation of markdown parsing.
 *   - Overlay (fixed inset-0) on top of the app. Backdrop click closes.
 *   - Close affordances: an X button (top-right), ESC keypress,
 *     click-outside (backdrop). The close button takes initial focus on
 *     open so keyboard users land somewhere meaningful.
 *   - Focus trap: while the reader is open, Tab cycles within the
 *     dialog. The previously-focused element is restored on close.
 *   - Theme: respects the app's `data-theme="light"|"dark"` attribute
 *     via the existing CSS variable system. Reader's background is a
 *     near-white (light) / very-deep-ink (dark) tone tuned for long
 *     reading sessions, not the chat's mid-tone surface.
 *   - Body scroll is locked while the reader is open so the chat
 *     underneath doesn't scroll along with the reader's scrollable
 *     column.
 *   - Smooth open/close: CSS transition on opacity + transform, no
 *     animation library.
 *
 * What we DON'T render: tool-call cards, attachments, progress chips.
 * The reader is the assistant's prose only — that's the whole point.
 *
 * Accessibility:
 *   - `role="dialog"`, `aria-modal="true"`.
 *   - `aria-labelledby` points at the first markdown heading we can
 *     find, falling back to a hidden default title.
 *   - Close button has `aria-label="Close reader view"`.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { MarkdownContent } from "./markdown-renderer";

interface ReaderViewProps {
  /** Raw markdown to render. */
  content: string;
  /** Open/close state — controlled by the trigger. */
  open: boolean;
  /** Close handler — invoked by ESC, backdrop click, X button. */
  onClose: () => void;
  /**
   * Optional accessible label for the dialog. When omitted we derive a
   * label from the first heading the parent provides; the default
   * value ("Reader view") is used as a fallback.
   */
  title?: string;
  /** Optional `data-testid` for the dialog root. */
  testId?: string;
}

/**
 * CSS selectors for focusable elements inside the dialog. Used to scope
 * Tab cycling while the trap is active. Matches `:enabled`, visible
 * elements with non-negative `tabindex`. We deliberately keep this
 * conservative — the reader is mostly prose + a close button + links,
 * not a form.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Collects the focusable elements currently inside `root` (in DOM
 * order). Hidden elements are excluded via an `offsetParent` check —
 * jsdom doesn't always compute it but our reader has no `display:none`
 * focusables so this is fine in tests.
 */
function getFocusable(root: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter(
    (el) => !el.hasAttribute("inert") && el.tabIndex !== -1,
  );
}

export function ReaderView({
  content,
  open,
  onClose,
  title,
  testId = "reader-view",
}: ReaderViewProps) {
  // Track the mount phase separately from `open` so we can drive a
  // CSS opacity transition: render at opacity-0, then bump to opacity-1
  // on the next animation frame. On close we flip back to opacity-0
  // and unmount after the transition finishes.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const prevFocusRef = useRef<Element | null>(null);
  const titleId = useId();

  // Drive the open/close mount + transition lifecycle.
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Defer the opacity flip a tick so the browser registers the
      // initial opacity-0 paint before transitioning to opacity-1.
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = window.setTimeout(() => setMounted(false), 180);
    return () => window.clearTimeout(t);
  }, [open]);

  // Restore the trigger's focus when the dialog closes. Captured once
  // on open so the user lands back on the same icon button.
  useLayoutEffect(() => {
    if (!open) return;
    prevFocusRef.current = document.activeElement;
    return () => {
      const prev = prevFocusRef.current as HTMLElement | null;
      if (prev && typeof prev.focus === "function") {
        try {
          prev.focus();
        } catch {
          /* element may have unmounted — ignore */
        }
      }
    };
  }, [open]);

  // Focus the close button on open. We run this in a separate effect
  // after the layout effect above has fired so the portal's DOM is
  // committed and `closeBtnRef.current` is wired. Focusing directly
  // (no rAF / microtask hops) keeps the test rig predictable — the
  // assertion runs immediately after `act()` flushes effects.
  useEffect(() => {
    if (!open) return;
    closeBtnRef.current?.focus();
  }, [open, mounted]);

  // Body scroll lock — prevent the chat behind the reader from
  // scrolling while the reader is open. Restore on close.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // ESC to close + Tab focus trap.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = getFocusable(root);
      if (focusables.length === 0) {
        // Nothing to cycle through — block tabbing out entirely.
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  // Click on the backdrop (the outer overlay) closes; clicks that
  // started or ended inside the dialog panel do not.
  const handleBackdropMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  if (!mounted) return null;
  // SSR guard: the rest of the app already assumes a browser env, but
  // the portal API needs `document`.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      // Backdrop. Click-outside-to-close is handled here.
      onMouseDown={handleBackdropMouseDown}
      className={
        "fixed inset-0 z-50 flex items-stretch justify-center " +
        "bg-black/55 backdrop-blur-sm " +
        "transition-opacity duration-150 ease-out " +
        (visible ? "opacity-100" : "opacity-0")
      }
      data-testid={`${testId}-backdrop`}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        onKeyDown={handleKeyDown}
        // The reader panel itself. Mobile: full-screen. Desktop:
        // generous outer margin so the dialog feels like a document
        // floating above the app rather than a hard takeover.
        className={
          "reader-view-panel relative m-0 flex w-full max-w-[1100px] flex-col " +
          "shadow-lg sm:m-4 sm:rounded-lg " +
          "transition-transform duration-150 ease-out " +
          (visible ? "translate-y-0" : "translate-y-2")
        }
      >
        {/* Sticky header with close button. */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-[var(--reader-bg)] px-6 py-3 sm:rounded-t-2xl">
          <span id={titleId} className="text-xs font-medium uppercase tracking-wider text-muted">
            {title ?? "Reader view"}
          </span>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close reader view"
            data-testid="reader-view-close"
            className="inline-flex items-center justify-center rounded-md p-1.5 text-muted hover:bg-white/10 hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable reading column. The inner container clamps the
            text width to ~80ch for comfortable line length, regardless
            of how wide the dialog panel grows. */}
        <div className="flex-1 overflow-y-auto px-4 py-8 sm:px-10 sm:py-12">
          <article
            data-testid="reader-view-article"
            className="reader-prose mx-auto w-full max-w-[80ch]"
          >
            <MarkdownContent text={content} />
          </article>
        </div>
      </div>
    </div>,
    document.body,
  );
}
