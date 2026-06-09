import { useEffect, useRef } from "react";
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

  // Focus the confirm button when opening; close on Escape.
  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="glass-section w-full max-w-md rounded-2xl p-6 mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-strong">{title}</h3>
          <button
            onClick={onCancel}
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
