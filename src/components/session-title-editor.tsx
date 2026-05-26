import { useRef, useState } from "react";
import { PencilLine } from "lucide-react";

interface SessionTitleEditorProps {
  value: string;
  onSave?: (value: string) => void;
  buttonClassName?: string;
  inputClassName?: string;
  testId?: string;
}

export function SessionTitleEditor({
  value,
  onSave,
  buttonClassName = "w-full text-left text-[1.24rem] font-semibold tracking-tight text-text-strong transition hover:text-accent",
  inputClassName = "w-full rounded-[12px] border border-accent/40 bg-surface-container px-3 py-2.5 text-[1.08rem] font-semibold tracking-tight text-text outline-none",
  testId = "session-title-editor",
}: SessionTitleEditorProps) {
  const [editing, setEditing] = useState(false);
  const cancelNextBlur = useRef(false);

  const commit = (raw: string) => {
    if (cancelNextBlur.current) {
      cancelNextBlur.current = false;
      return;
    }
    const next = raw.trim();
    if (next && next !== value) onSave?.(next);
    setEditing(false);
  };

  const cancel = () => {
    cancelNextBlur.current = true;
    setEditing(false);
  };

  if (editing && onSave) {
    return (
      <input
        data-testid={`${testId}-input`}
        aria-label="Session title"
        defaultValue={value}
        className={inputClassName}
        autoFocus
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") cancel();
        }}
      />
    );
  }

  if (!onSave) {
    return (
      <div data-testid={testId} className={buttonClassName}>
        {value}
      </div>
    );
  }

  return (
    <button
      type="button"
      data-testid={testId}
      className={`group inline-flex min-w-0 items-center gap-2 ${buttonClassName}`}
      title="Rename session"
      aria-label={`Rename session ${value}`}
      onClick={() => {
        cancelNextBlur.current = false;
        setEditing(true);
      }}
    >
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <PencilLine
        aria-hidden="true"
        className="h-4 w-4 shrink-0 opacity-55 transition group-hover:opacity-100"
      />
    </button>
  );
}
