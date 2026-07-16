import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { parseCsv } from "./csv-parser";

const MAX_CSV_RENDER_ROWS = 5_000;
const MAX_CSV_RENDER_CELLS = 50_000;
const MAX_JSON_RENDER_NODES = 5_000;
const MAX_JSON_RENDER_DEPTH = 100;

function jsonExceedsRenderLimits(value: unknown): boolean {
  let remainingNodes = MAX_JSON_RENDER_NODES;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    remainingNodes -= 1;
    if (remainingNodes < 0 || current.depth > MAX_JSON_RENDER_DEPTH) return true;
    if (!current.value || typeof current.value !== "object") continue;

    if (Array.isArray(current.value)) {
      if (current.value.length > remainingNodes - stack.length) return true;
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else {
      const object = current.value as Record<string, unknown>;
      const keys = Object.keys(object);
      if (keys.length > remainingNodes - stack.length) return true;
      for (const key of keys) {
        stack.push({ value: object[key], depth: current.depth + 1 });
      }
    }
  }
  return false;
}

function JsonValue({ name, value, depth = 0 }: {
  name?: string;
  value: unknown;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isArray = Array.isArray(value);
  const isObject = Boolean(value) && typeof value === "object";
  const entries = isObject ? Object.entries(value as Record<string, unknown>) : [];
  const label = name === undefined ? null : <span className="font-medium text-text-strong">{name}</span>;

  if (!isObject) {
    return (
      <div className="py-0.5 font-mono text-xs">
        {label}{label && <span className="text-muted">: </span>}
        <span className={typeof value === "string" ? "text-emerald-600" : "text-accent"}>
          {JSON.stringify(value)}
        </span>
      </div>
    );
  }

  return (
    <div className="font-mono text-xs">
      <button
        type="button"
        className="flex max-w-full items-center gap-1 py-0.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label}
        <span className="text-muted">{isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>
      </button>
      {open && (
        <div className="ml-2 border-l pl-3">
          {entries.map(([key, child]) => (
            <JsonValue key={key} name={key} value={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function JsonViewer({ text }: { text: string }) {
  const parsed = useMemo(() => {
    try {
      const value = JSON.parse(text) as unknown;
      return { value, error: null, tooLarge: jsonExceedsRenderLimits(value) };
    } catch (reason) {
      return {
        value: null,
        error: reason instanceof Error ? reason.message : "Invalid JSON",
        tooLarge: false,
      };
    }
  }, [text]);

  if (parsed.error) {
    return (
      <div className="h-full w-full overflow-auto">
        <p className="mb-2 text-xs text-amber-600">Invalid JSON: {parsed.error}</p>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs">{text}</pre>
      </div>
    );
  }
  if (parsed.tooLarge) {
    return (
      <p className="studio-empty-state m-4 text-xs" role="alert">
        This JSON is too large for the interactive JSON viewer. Download it to view the full content.
      </p>
    );
  }
  return <div className="h-full w-full overflow-auto"><JsonValue value={parsed.value} /></div>;
}

export function CsvTableViewer({ text, filename }: { text: string; filename: string }) {
  const parsed = useMemo(() => parseCsv(text, {
    maxRows: MAX_CSV_RENDER_ROWS + 1,
    maxCells: MAX_CSV_RENDER_CELLS,
  }), [text]);
  const rows = parsed.rows;
  const exceedsRenderLimit = parsed.overflow;
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [descending, setDescending] = useState(false);
  const columnCount = rows.reduce(
    (maximum, row) => Math.max(maximum, row.length),
    0,
  );
  const header = Array.from(
    { length: columnCount },
    (_, index) => rows[0]?.[index] ?? "",
  );
  const body = useMemo(() => {
    if (exceedsRenderLimit) return [];
    const values = rows.slice(1);
    if (sortColumn === null) return values;
    return [...values].sort((left, right) => {
      const result = (left[sortColumn] ?? "").localeCompare(right[sortColumn] ?? "", undefined, {
        numeric: true,
      });
      return descending ? -result : result;
    });
  }, [descending, exceedsRenderLimit, rows, sortColumn]);

  if (rows.length === 0) return <p className="text-sm text-muted">This CSV file is empty.</p>;
  if (exceedsRenderLimit) {
    return (
      <p className="studio-empty-state m-4 text-xs" role="alert">
        This CSV is too large for the interactive table. Download it to view the full content.
      </p>
    );
  }
  return (
    <div className="h-full w-full overflow-auto rounded-lg border bg-surface">
      <table className="min-w-full border-collapse text-left text-xs" aria-label={filename}>
        <thead className="sticky top-0 z-10 bg-surface-strong">
          <tr>
            {header.map((value, index) => (
              <th key={`${value}-${index}`} className="whitespace-nowrap border-b border-r px-3 py-2 font-medium">
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => {
                    if (sortColumn === index) setDescending((value) => !value);
                    else {
                      setSortColumn(index);
                      setDescending(false);
                    }
                  }}
                >
                  {value || `Column ${index + 1}`}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-surface/50">
              {header.map((_, columnIndex) => (
                <td key={columnIndex} className="max-w-[20rem] whitespace-pre-wrap border-b border-r px-3 py-2 align-top">
                  {row[columnIndex] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
