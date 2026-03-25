/**
 * NotebookMarkdown — renders markdown with [src:N] citation badges.
 * Issues #15 (citation rendering) and #16 (citation jump).
 */
import { memo, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import mermaid from "mermaid";

let mermaidCounter = 0;

function MermaidBlock({ content }: { content: string }) {
  const [svg, setSvg] = useState("");
  const idRef = useRef(`nb-mermaid-${++mermaidCounter}`);
  useEffect(() => {
    mermaid.render(idRef.current, content.trim())
      .then(({ svg: s }) => setSvg(s))
      .catch(() => {});
  }, [content]);
  if (!svg) return <pre className="my-2 rounded-lg bg-zinc-900 p-3 text-xs whitespace-pre-wrap">{content}</pre>;
  return <div className="my-2 overflow-x-auto rounded-lg bg-zinc-900 p-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

// ── Citation badge ──────────────────────────────────────────

function CitationBadge({ index, tooltip, onClick }: { index: number; tooltip?: string; onClick?: (index: number) => void }) {
  const [showTooltip, setShowTooltip] = useState(false);
  return (
    <span className="relative inline-block">
      <sup
        className="mx-0.5 cursor-pointer rounded bg-accent/15 px-1 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/25 transition"
        onClick={() => onClick?.(index)}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {index}
      </sup>
      {showTooltip && tooltip && (
        <span className="absolute bottom-full left-1/2 z-50 -translate-x-1/2 mb-1 whitespace-nowrap rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 shadow-lg">
          {tooltip}
        </span>
      )}
    </span>
  );
}

// ── Pre-process markdown to replace [src:N] with placeholder ─

interface ParsedSegment {
  type: "text" | "citation";
  value: string;
  index?: number;
}

function parseSegments(text: string): ParsedSegment[] {
  const regex = /\[src:(\d+)\]/g;
  const segments: ParsedSegment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ type: "text", value: text.slice(last, match.index) });
    }
    segments.push({ type: "citation", value: match[0], index: parseInt(match[1], 10) });
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "text", value: text.slice(last) });
  }
  return segments;
}

// We replace [src:N] before passing to ReactMarkdown so they become HTML spans.
// Strategy: replace [src:N] with a unique placeholder, then use a custom component.
const CITE_PLACEHOLDER = "%%CITE_";
const CITE_END = "%%";

function preprocessCitations(md: string): string {
  return md.replace(/\[src:(\d+)\]/g, `${CITE_PLACEHOLDER}$1${CITE_END}`);
}

// ── Main component ──────────────────────────────────────────

interface NotebookMarkdownProps {
  text: string;
  className?: string;
  sourceNames?: string[];
  onCitationClick?: (sourceIndex: number) => void;
}

export const NotebookMarkdown = memo(function NotebookMarkdown({
  text,
  className,
  sourceNames,
  onCitationClick,
}: NotebookMarkdownProps) {
  const handleCite = useCallback(
    (index: number) => {
      onCitationClick?.(index);
    },
    [onCitationClick],
  );

  // We render text nodes that contain citation placeholders with inline citations.
  // To do this, we override the `text` node in ReactMarkdown components.

  const components: Record<string, React.ComponentType<Record<string, unknown>>> = {
    // Override paragraph to handle citations within text
    p: ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) => {
      void rest;
      return <p className="mb-3 last:mb-0 leading-relaxed">{renderWithCitations(children, sourceNames, handleCite)}</p>;
    },
    li: ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) => {
      void rest;
      return <li className="leading-relaxed">{renderWithCitations(children, sourceNames, handleCite)}</li>;
    },
    td: ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) => {
      void rest;
      return <td className="border-b border-border/50 px-3 py-1.5">{renderWithCitations(children, sourceNames, handleCite)}</td>;
    },
    strong: ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) => {
      void rest;
      return <strong className="font-semibold text-text-strong">{renderWithCitations(children, sourceNames, handleCite)}</strong>;
    },
    em: ({ children, ...rest }: { children?: ReactNode; [k: string]: unknown }) => {
      void rest;
      return <em className="italic">{renderWithCitations(children, sourceNames, handleCite)}</em>;
    },
    // Keep the other elements from the base renderer
    table: ({ children }: { children?: ReactNode }) => (
      <div className="my-2 overflow-x-auto rounded-lg border border-border"><table className="min-w-full text-xs">{children}</table></div>
    ),
    th: ({ children }: { children?: ReactNode }) => (
      <th className="border-b border-border bg-surface-light px-3 py-1.5 text-left font-medium text-text-strong">{children}</th>
    ),
    ul: ({ children }: { children?: ReactNode }) => <ul className="mb-3 list-disc pl-5 space-y-1">{children}</ul>,
    ol: ({ children }: { children?: ReactNode }) => <ol className="mb-3 list-decimal pl-5 space-y-1">{children}</ol>,
    h1: ({ children }: { children?: ReactNode }) => <h1 className="mb-3 mt-5 text-xl font-bold text-text-strong">{children}</h1>,
    h2: ({ children }: { children?: ReactNode }) => <h2 className="mb-2 mt-4 text-lg font-bold text-text-strong">{children}</h2>,
    h3: ({ children }: { children?: ReactNode }) => <h3 className="mb-2 mt-3 text-base font-semibold text-text-strong">{children}</h3>,
    blockquote: ({ children }: { children?: ReactNode }) => (
      <blockquote className="my-3 border-l-3 border-accent pl-4 text-muted italic">{children}</blockquote>
    ),
    hr: () => <hr className="my-4 border-border" />,
    code: ({ children, className: cn }: { children?: ReactNode; className?: string }) => {
      const lang = cn?.replace("language-", "") || "";
      if (lang === "mermaid" && typeof children === "string") {
        return <MermaidBlock content={children} />;
      }
      if (!cn && typeof children === "string" && !children.includes("\n")) {
        return <code className="rounded bg-surface px-1.5 py-0.5 text-xs text-accent">{children}</code>;
      }
      return (
        <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-3 text-xs leading-relaxed">
          <code className={cn}>{children}</code>
        </pre>
      );
    },
    pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };

  const processed = preprocessCitations(text);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components as never}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
});

// ── Helper: walk ReactNode children and replace citation placeholders ─

function renderWithCitations(
  children: ReactNode,
  sourceNames: string[] | undefined,
  onCite: (index: number) => void,
): ReactNode {
  if (children == null) return children;
  if (typeof children === "string") {
    return expandCitations(children, sourceNames, onCite);
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === "string") {
        return <span key={i}>{expandCitations(child, sourceNames, onCite)}</span>;
      }
      return child;
    });
  }
  return children;
}

function expandCitations(
  text: string,
  sourceNames: string[] | undefined,
  onCite: (index: number) => void,
): ReactNode {
  const regex = /%%CITE_(\d+)%%/g;
  const parts: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const idx = parseInt(match[1], 10);
    const tooltip = sourceNames && sourceNames[idx - 1] ? `Source ${idx}: ${sourceNames[idx - 1]}` : `Source ${idx}`;
    parts.push(<CitationBadge key={key++} index={idx} tooltip={tooltip} onClick={onCite} />);
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  if (parts.length === 0) return text;
  return <>{parts}</>;
}

// Re-export parseSegments for other uses
export { parseSegments };
