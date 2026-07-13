import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Minus, Plus, Quote, Search } from "lucide-react";

export interface CitationTarget {
  chunkId: string;
  sourceId?: string;
  sourcePath?: string;
  title?: string;
  startLine?: number;
  endLine?: number;
  quote?: string;
}

function citationFromUnknown(value: unknown): CitationTarget | null {
  if (!value || typeof value !== "object") return null;
  const citation = value as Record<string, unknown>;
  const chunkId = citation.chunk_id ?? citation.chunkId;
  if (typeof chunkId !== "string" || !chunkId) return null;
  return {
    chunkId,
    sourceId: typeof (citation.source_id ?? citation.sourceId) === "string"
      ? String(citation.source_id ?? citation.sourceId)
      : undefined,
    sourcePath: typeof (citation.source_path ?? citation.sourcePath) === "string"
      ? String(citation.source_path ?? citation.sourcePath)
      : undefined,
    title: typeof citation.title === "string" ? citation.title : undefined,
    startLine: typeof (citation.start_line ?? citation.startLine) === "number"
      ? Number(citation.start_line ?? citation.startLine)
      : undefined,
    endLine: typeof (citation.end_line ?? citation.endLine) === "number"
      ? Number(citation.end_line ?? citation.endLine)
      : undefined,
    quote: typeof citation.quote === "string" ? citation.quote : undefined,
  };
}

interface MindNode {
  id: string;
  label: string;
  summary: string;
  parentId?: string;
  citations: CitationTarget[];
}

interface MindMapData {
  title: string;
  root: string;
  nodes: MindNode[];
}

function parseMindMap(text: string): MindMapData | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > 300) return null;
    const nodes = value.nodes.flatMap((raw): MindNode[] => {
      if (!raw || typeof raw !== "object") return [];
      const node = raw as Record<string, unknown>;
      if (typeof node.id !== "string" || typeof node.label !== "string" || typeof node.summary !== "string") return [];
      return [{
        id: node.id,
        label: node.label,
        summary: node.summary,
        parentId: typeof (node.parent_id ?? node.parentId) === "string"
          ? String(node.parent_id ?? node.parentId)
          : undefined,
        citations: Array.isArray(node.citations)
          ? node.citations.map(citationFromUnknown).filter((item): item is CitationTarget => Boolean(item))
          : [],
      }];
    });
    if (nodes.length !== value.nodes.length) return null;
    const nodesById = new Map<string, MindNode>();
    for (const node of nodes) {
      if (nodesById.has(node.id)) return null;
      nodesById.set(node.id, node);
    }
    for (const node of nodes) {
      const visited = new Set<string>();
      let current: MindNode | undefined = node;
      while (current?.parentId && nodesById.has(current.parentId)) {
        if (visited.has(current.id)) return null;
        visited.add(current.id);
        current = nodesById.get(current.parentId);
      }
    }
    return {
      title: typeof value.title === "string" ? value.title : "Mind Map",
      root: typeof value.root === "string" ? value.root : "Mind Map",
      nodes,
    };
  } catch {
    return null;
  }
}

function CitationList({ citations, onCitationOpen }: {
  citations: CitationTarget[];
  onCitationOpen?: (citation: CitationTarget) => void;
}) {
  if (citations.length === 0) return null;
  return (
    <ul className="mt-3 space-y-2">
      {citations.map((citation) => (
        <li key={citation.chunkId} className="rounded-lg border p-2 text-[11px] text-muted">
          <p>{citation.title ?? citation.sourceId ?? "Source"}{citation.startLine !== undefined ? ` · lines ${citation.startLine}–${citation.endLine ?? citation.startLine}` : ""}</p>
          {onCitationOpen && (
            <button type="button" className="mt-1 text-accent" aria-label="Open cited source" onClick={() => onCitationOpen(citation)}>
              Open source
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function MindBranch({
  node,
  all,
  collapsed,
  onToggle,
  onSelect,
}: {
  node: MindNode;
  all: MindNode[];
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (node: MindNode) => void;
}) {
  const children = all.filter((candidate) => candidate.parentId === node.id);
  const isCollapsed = collapsed.has(node.id);
  return (
    <li role="treeitem" className="relative ml-3 border-l border-accent/30 pl-3">
      <div className="my-2 flex items-center gap-1">
        {children.length > 0 && (
          <button type="button" className="studio-ghost-button p-1" aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.label}`} onClick={() => onToggle(node.id)}>
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
        <button type="button" className="studio-card rounded-xl px-3 py-2 text-left text-xs" aria-label={`Open node ${node.label}`} onClick={() => onSelect(node)}>
          {node.label}
        </button>
      </div>
      {!isCollapsed && children.length > 0 && (
        <ul role="group">
          {children.map((child) => <MindBranch key={child.id} node={child} all={all} collapsed={collapsed} onToggle={onToggle} onSelect={onSelect} />)}
        </ul>
      )}
    </li>
  );
}

export function MindMapViewer({ text, onCitationOpen }: {
  text: string;
  onCitationOpen?: (citation: CitationTarget) => void;
}) {
  const data = useMemo(() => parseMindMap(text), [text]);
  const [scale, setScale] = useState(1);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<MindNode | null>(null);
  if (!data) return <div className="studio-empty-state m-4 text-xs">The mind-map JSON is invalid. Open its Markdown fallback from Files.</div>;
  const roots = data.nodes.filter((node) => !node.parentId || !data.nodes.some((candidate) => candidate.id === node.parentId));
  const toggle = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b p-3">
        <div><h2 className="text-sm font-semibold">{data.title}</h2><p className="text-[11px] text-muted">{data.root}</p></div>
        <div className="flex gap-1">
          <button type="button" className="studio-ghost-button p-1.5" aria-label="Zoom out" onClick={() => setScale((value) => Math.max(0.6, value - 0.1))}><Minus size={14} /></button>
          <button type="button" className="studio-ghost-button p-1.5" aria-label="Zoom in" onClick={() => setScale((value) => Math.min(1.8, value + 0.1))}><Plus size={14} /></button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <ul role="tree" aria-label={`${data.title} mind map`} className="origin-top-left transition-transform motion-reduce:transition-none" style={{ transform: `scale(${scale})`, width: `${100 / scale}%` }}>
          {roots.map((node) => <MindBranch key={node.id} node={node} all={data.nodes} collapsed={collapsed} onToggle={toggle} onSelect={setSelected} />)}
        </ul>
      </div>
      {selected && (
        <aside className="max-h-48 shrink-0 overflow-y-auto border-t p-3">
          <h3 className="text-sm font-medium">{selected.label}</h3>
          <p className="mt-1 text-xs text-muted">{selected.summary}</p>
          <CitationList citations={selected.citations} onCitationOpen={onCitationOpen} />
        </aside>
      )}
    </div>
  );
}

interface TableColumn { id: string; label: string }
interface TableCell { columnId: string; value: string; citations: CitationTarget[] }
interface TableData { title: string; columns: TableColumn[]; rows: TableCell[][] }

function parseDataTable(text: string): TableData | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(value.columns) || !Array.isArray(value.rows) || value.rows.length > 1000) return null;
    const columns = value.columns.flatMap((raw): TableColumn[] => raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "string" && typeof (raw as Record<string, unknown>).label === "string"
      ? [{ id: String((raw as Record<string, unknown>).id), label: String((raw as Record<string, unknown>).label) }]
      : []);
    if (columns.length === 0 || columns.length !== value.columns.length) return null;
    const rows = value.rows.flatMap((raw): TableCell[][] => {
      if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).cells)) return [];
      const byColumn = new Map<string, TableCell>();
      for (const cellValue of (raw as { cells: unknown[] }).cells) {
        if (!cellValue || typeof cellValue !== "object") continue;
        const cell = cellValue as Record<string, unknown>;
        const columnId = cell.column_id ?? cell.columnId;
        if (typeof columnId !== "string") continue;
        byColumn.set(columnId, {
          columnId,
          value: String(cell.value ?? ""),
          citations: Array.isArray(cell.citations) ? cell.citations.map(citationFromUnknown).filter((item): item is CitationTarget => Boolean(item)) : [],
        });
      }
      return [[...columns.map((column) => byColumn.get(column.id) ?? { columnId: column.id, value: "", citations: [] })]];
    });
    return { title: typeof value.title === "string" ? value.title : "Data table", columns, rows };
  } catch {
    return null;
  }
}

export function DataTableViewer({ text, onCitationOpen }: {
  text: string;
  onCitationOpen?: (citation: CitationTarget) => void;
}) {
  const data = useMemo(() => parseDataTable(text), [text]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ index: number; descending: boolean } | null>(null);
  const [citations, setCitations] = useState<CitationTarget[]>([]);
  if (!data) return <div className="studio-empty-state m-4 text-xs">The canonical table JSON is invalid. Open CSV or Markdown from Files.</div>;
  const filtered = data.rows.filter((row) => row.some((cell) => cell.value.toLowerCase().includes(query.trim().toLowerCase())));
  const rows = sort ? [...filtered].sort((left, right) => {
    const result = left[sort.index].value.localeCompare(right[sort.index].value, undefined, { numeric: true });
    return sort.descending ? -result : result;
  }) : filtered;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative shrink-0 border-b p-3">
        <Search size={14} className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-muted" />
        <input type="search" data-with-icon className="studio-input h-8 text-xs" aria-label="Search table" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs" aria-label={data.title}>
          <thead className="sticky top-0 z-10 bg-surface-strong"><tr>{data.columns.map((column, index) => (
            <th key={column.id} className="border-b border-r px-3 py-2"><button type="button" onClick={() => setSort((current) => current?.index === index ? { index, descending: !current.descending } : { index, descending: false })}>{column.label}</button></th>
          ))}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell) => (
            <td key={cell.columnId} className="border-b border-r px-3 py-2 align-top"><span className="whitespace-pre-wrap">{cell.value}</span>{cell.citations.length > 0 && <button type="button" className="ml-1 inline-flex text-accent" aria-label={`View citations for ${cell.value}`} onClick={() => setCitations(cell.citations)}><Quote size={12} /></button>}</td>
          ))}</tr>)}</tbody>
        </table>
      </div>
      {citations.length > 0 && <aside className="max-h-40 shrink-0 overflow-y-auto border-t p-3"><h3 className="text-xs font-medium">Citations</h3><CitationList citations={citations} onCitationOpen={onCitationOpen} /></aside>}
    </div>
  );
}

export function VideoScenesViewer({ text, onCitationOpen }: {
  text: string;
  onCitationOpen?: (citation: CitationTarget) => void;
}) {
  const data = useMemo(() => {
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (!Array.isArray(value.scenes) || value.scenes.length === 0 || value.scenes.length > 200) return null;
      const scenes = value.scenes.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const scene = raw as Record<string, unknown>;
        if (typeof scene.visual !== "string" || typeof scene.narration !== "string") return [];
        return [{
          number: typeof scene.scene === "number" ? scene.scene : 0,
          type: typeof scene.type === "string" ? scene.type : "scene",
          visual: scene.visual,
          narration: scene.narration,
          citations: Array.isArray(scene.citations)
            ? scene.citations.map(citationFromUnknown).filter((item): item is CitationTarget => Boolean(item))
            : [],
        }];
      });
      if (scenes.length !== value.scenes.length) return null;
      return {
        title: typeof value.title === "string" ? value.title : "Scene plan",
        style: typeof value.style === "string" ? value.style : "",
        duration: typeof value.duration_minutes === "number" ? value.duration_minutes : undefined,
        scenes,
      };
    } catch {
      return null;
    }
  }, [text]);
  if (!data) return <div className="studio-empty-state m-4 text-xs">The scene plan is invalid. Open the raw JSON from Files.</div>;
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4"><h2 className="text-sm font-semibold">{data.title}</h2><p className="text-[11px] text-muted">{[data.style, data.duration ? `${data.duration} min` : ""].filter(Boolean).join(" · ")}</p></div>
      <ol className="space-y-3">
        {data.scenes.map((scene, index) => (
          <li key={`${scene.number}-${index}`} className="studio-card rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-sm font-medium">Scene {scene.number || index + 1}</h3><span className="rounded-full border px-2 py-0.5 text-[10px] uppercase text-muted">{scene.type}</span></div>
            <p className="text-xs"><span className="font-medium">Visual: </span>{scene.visual}</p>
            <p className="mt-2 text-xs text-muted"><span className="font-medium text-text-strong">Narration: </span>{scene.narration}</p>
            <CitationList citations={scene.citations} onCitationOpen={onCitationOpen} />
          </li>
        ))}
      </ol>
    </div>
  );
}
