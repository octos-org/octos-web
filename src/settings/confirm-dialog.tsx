import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  variant?: "danger" | "warning" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

const VARIANT_STYLES: Record<
  NonNullable<ConfirmDialogProps["variant"]>,
  string
> = {
  danger:
    "bg-red-500 hover:bg-red-600 text-white",
  warning:
    "bg-yellow-500 hover:bg-yellow-600 text-black",
  default:
    "bg-accent hover:bg-accent-dim text-white",
};

/**
 * Accessible confirmation modal.
 *
 * - `role="dialog"` + `aria-modal` + labelled-by title
 * - focuses the safer action (Cancel for danger variants) on open
 * - traps Tab inside the dialog
 * - restores focus to the previously focused element on close
 * - Escape cancels (keydown handler is shared with the focus logic)
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Focus the safer action for destructive dialogs; trap Tab; restore
  // focus to the invoker on close.
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    if (variant === "danger") {
      cancelRef.current?.focus();
    } else {
      confirmRef.current?.focus();
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previouslyFocusedRef.current?.focus?.();
      previouslyFocusedRef.current = null;
    };
  }, [open, onCancel, variant]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        className="glass-section w-full max-w-md rounded-lg p-6 mx-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <h3 id={titleId} className="text-sm font-semibold text-text-strong">
            {title}
          </h3>
          <button
            onClick={onCancel}
            aria-label="Close dialog"
            className="rounded-lg p-1 text-muted hover:text-text-strong hover:bg-surface-container transition"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <p className="text-sm text-muted leading-relaxed mb-6">{body}</p>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-xl border border-border px-4 py-2 text-sm text-muted hover:text-text-strong hover:border-accent/30 transition"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`rounded-xl px-5 py-2 text-sm font-medium transition ${VARIANT_STYLES[variant]}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
