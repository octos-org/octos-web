/**
 * Trigger button that opens the fullscreen `ReaderView` for an
 * assistant message. Owns the open/close state so the caller (the
 * assistant bubble) doesn't need to thread state through.
 *
 * Visual + UX matches the sibling `CopyMarkdownButton`: ghost icon,
 * 40% opacity at rest, full opacity on hover/focus or bubble-hover.
 * Touch devices keep the 40% baseline so the affordance is
 * discoverable (Tailwind v4's `group-hover` is gated under
 * `@media (hover: hover)` and never fires on coarse pointers).
 */

import { useCallback, useState } from "react";
import { Maximize2 } from "lucide-react";
import { ReaderView } from "./reader-view";

interface ReaderViewTriggerProps {
  /** Raw markdown to show inside the reader. */
  content: string;
  /** Optional `data-testid` for the trigger button. */
  testId?: string;
  /** Extra classes appended after the default Tailwind chain. */
  className?: string;
}

export function ReaderViewTrigger({
  content,
  testId = "reader-view-trigger",
  className = "",
}: ReaderViewTriggerProps) {
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        data-testid={testId}
        onClick={handleOpen}
        aria-label="Open reader view"
        title="Open in reader view"
        className={
          "inline-flex items-center justify-center rounded-md p-1 text-muted/60 " +
          "opacity-40 transition-opacity duration-150 " +
          "group-hover/assistant:opacity-100 hover:opacity-100 focus:opacity-100 focus:outline-none " +
          "hover:bg-white/10 hover:text-text " +
          className
        }
      >
        <Maximize2 size={14} aria-hidden="true" />
      </button>
      <ReaderView
        content={content}
        open={open}
        onClose={handleClose}
        title="Reader view"
      />
    </>
  );
}
