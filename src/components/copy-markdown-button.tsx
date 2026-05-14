/**
 * Small ghost icon button that copies the raw markdown of an assistant
 * bubble to the clipboard.
 *
 * UX contract (matches ChatGPT / Claude.ai pattern):
 *   - Subtle by default, fades in on bubble hover.
 *   - Click writes `content` to `navigator.clipboard.writeText`.
 *   - On success: swap the copy glyph for a checkmark for 1.5s, then
 *     revert. Pure local React state — no portal, no toast plumbing.
 *   - On failure: surface an inline "failed" state for 1.5s and update
 *     `aria-label` so screen readers announce the error. We deliberately
 *     don't ship a toast — the project has no toast system today.
 *   - Insecure-context fallback: when `navigator.clipboard` is missing
 *     (HTTP page, etc.) we fall back to a hidden `<textarea>` +
 *     `document.execCommand("copy")` so the button still works in
 *     non-HTTPS dev environments.
 *
 * Callers are responsible for gating render on "message finalized"
 * (e.g. `message.status === "complete"`). This component does not know
 * about thread-store types — it just takes a `content` string.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";

type CopyState = "idle" | "copied" | "error";

/** Window for the success/error icon swap before reverting to idle. */
const FEEDBACK_DURATION_MS = 1500;

interface CopyMarkdownButtonProps {
  /** Raw markdown to write to the clipboard. Required and non-empty. */
  content: string;
  /** Optional `data-testid`. Defaults to `copy-markdown-button`. */
  testId?: string;
  /** Extra classes appended after the default Tailwind chain. */
  className?: string;
}

/**
 * Fallback path for insecure contexts (HTTP, file://) where
 * `navigator.clipboard` is unavailable. Returns true on success.
 *
 * `execCommand("copy")` is deprecated but still the only universal
 * fallback. We mount the hidden textarea on body, select it, fire the
 * command, then remove it synchronously — no DOM leak even if the call
 * throws.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Out-of-flow so it can't affect layout / scroll position.
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export function CopyMarkdownButton({
  content,
  testId = "copy-markdown-button",
  className = "",
}: CopyMarkdownButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const timerRef = useRef<number | null>(null);

  // Clean up any pending revert timer on unmount so a fast-clicking
  // user can't trigger a setState on a disposed component.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const scheduleRevert = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setState("idle");
    }, FEEDBACK_DURATION_MS);
  }, []);

  const handleClick = useCallback(() => {
    if (!content) return;
    const onOk = () => {
      setState("copied");
      scheduleRevert();
    };
    const onFail = () => {
      setState("error");
      scheduleRevert();
    };

    // Prefer the async clipboard API (only in secure contexts).
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard
        .writeText(content)
        .then(onOk)
        .catch(() => {
          // Permission denied (or insecure context with a stub
          // present) — try the legacy path before giving up.
          if (legacyCopy(content)) onOk();
          else onFail();
        });
      return;
    }
    if (legacyCopy(content)) onOk();
    else onFail();
  }, [content, scheduleRevert]);

  const ariaLabel =
    state === "copied"
      ? "Copied"
      : state === "error"
        ? "Copy failed"
        : "Copy as markdown";
  const title =
    state === "copied"
      ? "Copied"
      : state === "error"
        ? "Copy failed"
        : "Copy as markdown";

  return (
    <button
      type="button"
      data-testid={testId}
      data-state={state}
      onClick={handleClick}
      aria-label={ariaLabel}
      title={title}
      className={
        // Visible-by-default with low opacity so touch-only devices
        // (where `group-hover/assistant:opacity-100` is gated under
        // `@media (hover:hover)` in Tailwind v4 and never fires) can
        // still discover + tap the affordance. On hover-capable devices
        // the bubble's `group/assistant` hover and the button's own
        // hover/focus state bump it to full opacity.
        "inline-flex items-center justify-center rounded-md p-1 text-muted/60 " +
        "opacity-40 transition-opacity duration-150 " +
        "group-hover/assistant:opacity-100 hover:opacity-100 focus:opacity-100 focus:outline-none " +
        "hover:bg-white/10 hover:text-text " +
        (state === "copied" ? "text-accent opacity-100 " : "") +
        (state === "error" ? "text-red-400 opacity-100 " : "") +
        className
      }
    >
      {state === "copied" ? (
        <Check size={14} aria-hidden="true" />
      ) : state === "error" ? (
        <X size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  );
}
